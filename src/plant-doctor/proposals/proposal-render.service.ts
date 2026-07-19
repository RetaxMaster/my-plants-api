import { Injectable } from '@nestjs/common';
import type { DoctorWriteProposal, ProgressHealth, Task } from '@prisma/client';
import type { GrowthHabit, PotType, ProgressTagKey, SoilMix, WindowDist } from '@retaxmaster/my-plants-species-schema';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ymdFromUtcDate } from '../../common/time/local-date.js';
import { ProposalSnapshotService } from './proposal-snapshot.service.js';
import type { ProposalOperation } from './proposal-operations.schema.js';

/**
 * ONE field-level change, fully rendered by the SERVER as display strings.
 *
 * This shape — not a raw payload object — is the contract, and the reason is spec §5.4: the target and
 * the before/after values must be "resolved to a human label the server owns". Handing the browser
 * `{ intervalDays: 7 }` would force it to know that `intervalDays` means "Water every N days", which is
 * a SECOND implementation of "what does this change mean", free to drift from the one that actually
 * applies the write. The owner must approve exactly what the server will do, described the way the
 * server describes it. This type is mirrored verbatim by `DoctorProposalChange` in the web's
 * `types/api.ts` — the web declares it, the server owns it, neither re-derives it.
 */
export type RenderedChange = {
  /** Server-owned human label for the field ("Pot type", "Every (days)"). */
  field: string;
  /**
   * ALWAYS the value to display as current: normally the immutable snapshot, and — when the record
   * drifted since the agent looked — the LIVE value (spec §5.5.3 forbids showing a stale snapshot as
   * current). `null` = the field currently has no value.
   */
  before: string | null;
  /** The proposed value, rendered. `null` = the operation CLEARS the field. */
  after: string | null;
  /**
   * Present ONLY when the live value drifted from the snapshot. Carries the third value — what the
   * agent originally saw — so all three of §5.5.3's values (snapshot / live / proposed) are on the
   * wire: `stale.atProposeTime` / `before` / `after` respectively.
   */
  stale?: { atProposeTime: string | null };
};

export type RenderedOperation = {
  type: ProposalOperation['type'];
  /** A human label the SERVER owns: the entry's date, the task name, the place's name. */
  targetLabel: string;
  changes: RenderedChange[];
  /** True for progress.delete — the entry and its photos are NOT recoverable (spec 7.2). */
  destructive: boolean;
};

export type ProposalView = {
  id: string;
  status: string;
  autoApproved: boolean;
  failureCode: string | null;
  failureReason: string | null;
  createdAt: Date;
  operations: RenderedOperation[];
  /** Agent-authored prose. A CAPTION ONLY — consent is on `operations` (spec 5.4). */
  summary: string;
};

/** Keys that identify the TARGET of an operation rather than a value it changes. */
const IDENTITY_KEYS = new Set(['entryId', 'task']);

/**
 * The consent surface's language (spec's B2 fix). This is NOT a client-resolved i18n key: the owner's
 * `x-locale` header only tells the server which STRING TABLE to render from — the server still produces
 * the final text, so `en` vs `es` can never disagree about what a change MEANS, only about which words
 * describe it. `resolveLocale` is the one place that decides what counts as "es"; everywhere else in this
 * file just asks "is `locale === 'es'`?" against its result.
 */
export type Locale = 'en' | 'es';

/**
 * `x-locale` arrives off an HTTP header the BFF only loosely validates before forwarding (any
 * 2-20-char alnum/dash token passes there — see `my-plants-web/server/api/[...].ts`), so this is the
 * actual security/UX boundary for "what locale is this?". Anything other than the exact literal `'es'`
 * — absent, a typo, `'es-MX'`, garbage — becomes English. Falling back rather than throwing matters here
 * specifically: the ONE screen where a malformed header must never turn into a 500 is the one the owner
 * needs to read to approve a write.
 */
export function resolveLocale(raw: unknown): Locale {
  return raw === 'es' ? 'es' : 'en';
}

/**
 * Server-owned field labels, English. This used to be listed alongside the project's one KNOWN,
 * DOCUMENTED i18n leak (`care.viability.reasons`) — it no longer belongs there: `FIELD_LABELS_ES` below
 * closes this one. `care.viability.reasons` stays open; this file is not the place that fixes it.
 * Adding an operation field without adding its label is caught by the parity test, which walks the
 * operations union itself rather than a hand-written list.
 */
export const FIELD_LABELS: Record<string, string> = {
  // profile.update — the 9 fields
  windowDistance: 'Distance from the window',
  growLight: 'Grow light',
  potType: 'Pot type',
  potSizeCm: 'Pot size (cm)',
  hasDrainage: 'Drainage',
  soilMix: 'Soil mix',
  growthHabit: 'Growth habit',
  ageMonths: 'Age (months)',
  nearHeater: 'Near a heater',
  // plant.update
  nickname: 'Nickname',
  placeId: 'Place',
  // progress.*
  health: 'Health',
  occurredOn: 'Date',
  observations: 'Observations',
  sizeCm: 'Size (cm)',
  tags: 'Tags',
  // frequency.*
  intervalDays: 'Every (days)',
};

/**
 * The Spanish half of `FIELD_LABELS`, same key set, wording copied from the web's own i18n catalogue
 * wherever one already exists (`my-plants-web/i18n/locales/es.json` — `careBasis.fields.*`,
 * `plantProfile.*`, `progress.*`, `plantEdit.*`) so the two surfaces never disagree on a word. Where the
 * web has no equivalent noun-form label (`health`, `intervalDays`), this writes one in the same idiom.
 * The parity test walks the SAME operations union as the English table's test and fails if a key is
 * missing here — a hand-maintained "translate this too" checklist rots the moment someone forgets it.
 */
export const FIELD_LABELS_ES: Record<string, string> = {
  windowDistance: 'Distancia a la ventana',
  growLight: 'Luz de cultivo',
  potType: 'Tipo de maceta',
  potSizeCm: 'Tamaño de maceta (cm)',
  hasDrainage: 'Orificio de drenaje',
  soilMix: 'Sustrato',
  growthHabit: 'Hábito de crecimiento',
  ageMonths: 'Edad (meses)',
  nearHeater: 'Cerca de un calefactor',
  nickname: 'Apodo',
  placeId: 'Lugar',
  health: 'Salud',
  occurredOn: 'Fecha',
  observations: 'Observaciones',
  sizeCm: 'Tamaño (cm)',
  tags: 'Etiquetas',
  intervalDays: 'Cada (días)',
};

function fieldLabel(key: string, locale: Locale): string {
  // Falls back through EN, then the raw key — never blank. A field the ES table has not caught up with
  // (which the parity test should prevent from ever shipping) still reads as *something* the owner can
  // recognise, rather than disappearing from the row.
  return (locale === 'es' ? FIELD_LABELS_ES[key] : undefined) ?? FIELD_LABELS[key] ?? key;
}

/**
 * The literal target-label strings `label()` returns for operation types that have no natural id/date to
 * point at (`plant.update` with no `placeId`, `profile.update`, `progress.create`). Lower-case, matching
 * the English literals' own casing (`'nickname'`, `'profile'`, `'new progress entry'`) — these read as a
 * generic noun phrase next to the operation-type header, not as a title.
 */
const TARGET_LABEL_LITERALS_ES: Record<string, string> = {
  nickname: 'apodo',
  profile: 'perfil',
  'new progress entry': 'nuevo registro de progreso',
};

/**
 * Task names, Spanish. Copied verbatim from the web's `tasks.labels.*` (the infinitive/noun form used
 * for a task's NAME, as opposed to `tasks.past.*` which narrates it as already done — a target label
 * names the task the operation is ABOUT, it does not narrate an action taken).
 *
 * Keyed on the FULL Prisma `Task` enum (including `PROGRESS`) even though the operation union's own
 * `task` field is typed to the narrower `FREQUENCY_BEARING_TASKS` (PROGRESS excluded, spec 5.5.2) — the
 * parity test walks the real enum, and a table keyed to a subset would pass that test for the wrong
 * reason if the excluded member ever became reachable some other way.
 */
export const TASK_LABELS: Record<Locale, Record<Task, string>> = {
  // Taken verbatim from the web's `tasks.labels.*` in BOTH locales, so the name the owner approves here
  // is the same name they see on the plant's own care list. `WATER` had been left as the raw enum in
  // English — the last machine token on the consent surface, and the one attached to the operation that
  // changes when a plant gets watered.
  en: {
    WATER: 'Water',
    FERTILIZE: 'Fertilize',
    REPOT: 'Check the roots',
    ROTATE: 'Rotate',
    CLEAN_LEAVES: 'Clean leaves',
    MIST: 'Mist leaves',
    PROGRESS: 'Log progress',
  },
  es: {
    WATER: 'Regar',
    FERTILIZE: 'Fertilizar',
    REPOT: 'Revisar las raíces',
    ROTATE: 'Rotar',
    CLEAN_LEAVES: 'Limpiar hojas',
    MIST: 'Rociar hojas',
    PROGRESS: 'Registrar progreso',
  },
};

// Profile-field enum vocabularies, Spanish — copied verbatim from the matching `*Options` maps in the
// web's `plantProfile.*` i18n namespace, which is what `PlantProfileModal.vue` already shows the owner
// for these exact fields. `Record<WindowDist, string>` etc. make the compiler itself enforce parity: if
// `WINDOW_DISTANCES` (the single source of truth in `my-plants-species-schema`) ever gains a member, this
// object literal fails to typecheck until it is updated — the runtime parity test is defence in depth on
// top of that, not the only guard.
const WINDOW_DISTANCE_LABELS_ES: Record<WindowDist, string> = {
  'on-sill': 'En el alféizar',
  'within-1m': 'A menos de 1 m de una ventana',
  '1-to-2m': 'De 1 a 2 m de una ventana',
  '2-to-3m': 'De 2 a 3 m de una ventana',
  'over-3m': 'A más de 3 m de una ventana',
  outdoors: 'En exterior',
};

const POT_TYPE_LABELS_ES: Record<PotType, string> = {
  terracotta: 'Terracota',
  'unglazed-ceramic': 'Cerámica sin esmaltar',
  'glazed-ceramic': 'Cerámica esmaltada',
  plastic: 'Plástico',
  porcelain: 'Porcelana',
  metal: 'Metal',
  concrete: 'Concreto',
  fabric: 'Tela',
  other: 'Otro',
};

const SOIL_MIX_LABELS_ES: Record<SoilMix, string> = {
  aroid: 'Mezcla para aroides',
  'all-purpose': 'Uso general',
  'cactus-succulent': 'Cactus y suculentas',
  'orchid-bark': 'Corteza para orquídeas',
  'peat-based': 'A base de turba',
  'coco-coir': 'Fibra de coco',
  'semi-hydro': 'Semihidropónico',
  other: 'Otro',
};

const GROWTH_HABIT_LABELS_ES: Record<GrowthHabit, string> = {
  upright: 'Erguida',
  climber: 'Trepadora',
  trailing: 'Colgante',
  clumping: 'En macolla',
  rosette: 'Roseta',
  tree: 'Árbol',
  shrub: 'Arbusto',
  other: 'Otro',
};

/**
 * `ProgressHealth`, Spanish — copied verbatim from the web's `health.*` namespace (NOT from the
 * Prisma schema's own `// "..."` inline comments: those say `POOR // "Mal"`, but the shipped UI actually
 * renders `POOR` as "Regular" — the i18n file is the live product string and wins over a stale comment).
 */
const PROGRESS_HEALTH_LABELS_ES: Record<ProgressHealth, string> = {
  SICK: 'Enferma',
  POOR: 'Regular',
  GOOD: 'Bien',
  EXCELLENT: 'Excelente',
};

/** `PROGRESS_TAG_KEYS`, Spanish — copied verbatim from the web's `progress.tags.*`. */
const PROGRESS_TAG_LABELS_ES: Record<ProgressTagKey, string> = {
  NEW_LEAF: 'Hoja nueva',
  FLOWERING: 'Floreciendo',
  SEEDLING: 'Plántula',
  LARGE_LEAVES: 'Hojas grandes',
  NEW_SHOOTS: 'Brotes nuevos',
  BLOOM_COMPLETED: 'Floración terminada',
  FALLEN_LEAF: 'Hoja caída',
  DROOPING: 'Decaída',
  DRY_LEAVES: 'Hojas secas',
  YELLOWING_LEAVES: 'Hojas amarillentas',
  NOT_GROWING: 'Sin crecer',
  STUNTED_GROWTH: 'Crecimiento detenido',
  LEANING: 'Inclinada',
  PESTS: 'Plagas',
  FUNGUS: 'Hongos',
  SPOTS: 'Manchas',
  DISCOLORATION: 'Decoloración',
};

// Profile-field enum vocabularies, English — the mirror of the six ES tables above, copied verbatim
// from the SAME product strings those were copied from (`my-plants-web/i18n/locales/en.json` —
// `plantProfile.*Options`, `health.*`, `progress.tags.*`), never invented wording. Before this table
// existed, `en` fell through `formatValue` all the way to `String(value)`, so the owner's consent
// banner showed the raw machine slug (`terracotta`, `GOOD`, `NEW_LEAF`) instead of the same prose the
// rest of the product already uses for these exact values. `Record<PotType, string>` etc. give the
// compiler the same parity guard the ES tables have: a new enum member fails to typecheck here until
// this table catches up, in both locales symmetrically.
const WINDOW_DISTANCE_LABELS_EN: Record<WindowDist, string> = {
  'on-sill': 'On the windowsill',
  'within-1m': 'Within 1 m of a window',
  '1-to-2m': '1–2 m from a window',
  '2-to-3m': '2–3 m from a window',
  'over-3m': 'More than 3 m from a window',
  outdoors: 'Outdoors',
};

const POT_TYPE_LABELS_EN: Record<PotType, string> = {
  terracotta: 'Terracotta',
  'unglazed-ceramic': 'Unglazed ceramic',
  'glazed-ceramic': 'Glazed ceramic',
  plastic: 'Plastic',
  porcelain: 'Porcelain',
  metal: 'Metal',
  concrete: 'Concrete',
  fabric: 'Fabric',
  other: 'Other',
};

const SOIL_MIX_LABELS_EN: Record<SoilMix, string> = {
  aroid: 'Aroid mix',
  'all-purpose': 'All-purpose',
  'cactus-succulent': 'Cactus & succulent',
  'orchid-bark': 'Orchid bark',
  'peat-based': 'Peat-based',
  'coco-coir': 'Coco coir',
  'semi-hydro': 'Semi-hydro',
  other: 'Other',
};

const GROWTH_HABIT_LABELS_EN: Record<GrowthHabit, string> = {
  upright: 'Upright',
  climber: 'Climber',
  trailing: 'Trailing',
  clumping: 'Clumping',
  rosette: 'Rosette',
  tree: 'Tree',
  shrub: 'Shrub',
  other: 'Other',
};

const PROGRESS_HEALTH_LABELS_EN: Record<ProgressHealth, string> = {
  SICK: 'Sick',
  POOR: 'Poor',
  GOOD: 'Good',
  EXCELLENT: 'Excellent',
};

const PROGRESS_TAG_LABELS_EN: Record<ProgressTagKey, string> = {
  NEW_LEAF: 'New leaf',
  FLOWERING: 'Flowering',
  SEEDLING: 'Seedling',
  LARGE_LEAVES: 'Large leaves',
  NEW_SHOOTS: 'New shoots',
  BLOOM_COMPLETED: 'Bloom completed',
  FALLEN_LEAF: 'Fallen leaf',
  DROOPING: 'Drooping',
  DRY_LEAVES: 'Dry leaves',
  YELLOWING_LEAVES: 'Yellowing leaves',
  NOT_GROWING: 'Not growing',
  STUNTED_GROWTH: 'Stunted growth',
  LEANING: 'Leaning',
  PESTS: 'Pests',
  FUNGUS: 'Fungus',
  SPOTS: 'Spots',
  DISCOLORATION: 'Discoloration',
};

/**
 * WHICH vocabulary applies is decided by the FIELD KEY, not by the value's shape — `potType: 'plastic'`
 * and some unrelated free-text field that happened to also hold the string `'plastic'` must not share a
 * lookup. This map is the one place that decision is made; `formatValue` never guesses it per-call.
 * Fields absent here (place names, nicknames, observations, numbers, dates) are exactly the ones spec
 * says the server does not own the vocabulary of — they fall through to `String(value)` untouched.
 *
 * Keyed by LOCALE first, then by field key — one structure selected by `locale`, rather than an
 * `en`/`es` table pair with the `en === undefined` special case `formatValue` used to need. Both
 * locale's inner maps cover the exact same six field keys, which is what makes the two symmetric: a
 * vocabulary either exists for both locales or for neither.
 */
export const VALUE_VOCAB: Record<Locale, Record<string, Record<string, string>>> = {
  en: {
    windowDistance: WINDOW_DISTANCE_LABELS_EN,
    potType: POT_TYPE_LABELS_EN,
    soilMix: SOIL_MIX_LABELS_EN,
    growthHabit: GROWTH_HABIT_LABELS_EN,
    health: PROGRESS_HEALTH_LABELS_EN,
    tags: PROGRESS_TAG_LABELS_EN,
  },
  es: {
    windowDistance: WINDOW_DISTANCE_LABELS_ES,
    potType: POT_TYPE_LABELS_ES,
    soilMix: SOIL_MIX_LABELS_ES,
    growthHabit: GROWTH_HABIT_LABELS_ES,
    health: PROGRESS_HEALTH_LABELS_ES,
    tags: PROGRESS_TAG_LABELS_ES,
  },
};

/**
 * Render ONE value as the display string the owner consents to. `key` is what selects a vocabulary (see
 * `VALUE_VOCAB` above) for BOTH locales now — `en` used to fall through to `String(value)` for every
 * enum value (an unresolved slug reading as English-ish, e.g. `terracotta`); that was the defect this
 * key -> vocabulary path fixes, symmetrically, for `en` and `es` alike.
 */
function formatValue(value: unknown, locale: Locale, key: string): string | null {
  if (value === undefined || value === null) return null;
  // `locale` is typed `Locale`, but `render()` is a public method a caller could still hand a garbage
  // string through a type-erasure boundary (an untyped HTTP layer, a test) — `VALUE_VOCAB[locale]` falls
  // back to the English table rather than indexing `undefined`, the same "anything but 'es' is English"
  // rule every other locale check in this file already follows.
  const vocab = (VALUE_VOCAB[locale] ?? VALUE_VOCAB.en)[key];
  if (Array.isArray(value)) {
    if (!value.length) return null; // tags: [] renders as "cleared"
    // An unresolvable member (a value the vocabulary does not cover) falls back to itself, never to a
    // blank — the same rule `formatField`'s placeId lookup follows for an unresolvable id.
    return value.map((v) => (vocab && typeof v === 'string' ? (vocab[v] ?? v) : String(v))).join(', ');
  }
  if (typeof value === 'boolean') return locale === 'es' ? (value ? 'Sí' : 'No') : value ? 'Yes' : 'No';
  // Calendar dates are locale-INVARIANT by the project's own date rule — `YYYY-MM-DD` is not reformatted
  // per locale, it is the one unambiguous representation every surface in this project already uses.
  if (value instanceof Date) return ymdFromUtcDate(value);
  if (vocab && typeof value === 'string') return vocab[value] ?? value;
  return String(value);
}

@Injectable()
export class ProposalRenderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly snapshots: ProposalSnapshotService,
  ) {}

  /**
   * `locale` defaults to `'en'` so every EXISTING caller (unit tests, the agent-facing `create()` path)
   * keeps rendering exactly what it renders today without having to think about locale at all — this is
   * additive, never a behaviour change for `en`. Owner-facing callers (`ProposalsService.getPending` /
   * `approve` / `decline`) pass the locale resolved from the request's `x-locale` header; the agent-facing
   * `create()` passes `'en'` EXPLICITLY (spec: the propose response is the agent's own read-back and the
   * audit's account, never owner-facing UI, so it must never follow the owner's locale).
   */
  async render(proposal: DoctorWriteProposal, locale: Locale = 'en'): Promise<ProposalView> {
    const operations = JSON.parse(proposal.operations) as ProposalOperation[];
    const stored = JSON.parse(proposal.snapshot) as (Record<string, unknown> | null)[];
    // ⚠️ THE LIVE RE-READ IS FOR PENDING PROPOSALS ONLY.
    //
    // Drift detection answers ONE question: "has the record moved under a proposal the owner has not
    // decided on yet?" (spec §5.5.3). That question only exists while the proposal is PENDING. Once it is
    // terminal — APPROVED (including auto-approved under Skip Permissions), DECLINED, EXPIRED or FAILED —
    // this view is a STATEMENT OF RECORD: what was proposed, against the values it was proposed over.
    // Spec §5.4 pins `before` to the stored snapshot, and this response is both the agent's answer and the
    // audit's account of what changed.
    //
    // Re-reading live here on a terminal proposal reads back the proposal's OWN effect: after an apply the
    // live value IS the proposed value, so every change renders `before === after` (a no-op) carrying a
    // spurious `stale` marker that claims someone else moved the record. That is not a cosmetic defect —
    // it makes an applied write describe itself as "nothing happened, and by the way it drifted".
    // Measured on the Skip Permissions path, which is the only one that renders a terminal proposal to the
    // agent immediately after applying it.
    //
    // Using the stored snapshot as its own "live" value is what makes the comparison below yield "no
    // drift" for every field, rather than special-casing each `isStale` site.
    const live =
      proposal.status === 'PENDING'
        ? // Re-reading the CURRENT values through the same capture path the snapshot used is what makes
          // the stale comparison a like-for-like one: two implementations would differ in formatting
          // alone and mark every field as drifted.
          await this.snapshots.capture(proposal.plantId, proposal.ownerId, operations)
        : stored;

    const rendered: RenderedOperation[] = [];
    for (let i = 0; i < operations.length; i += 1) {
      const op = operations[i]!;
      const { type: _type, ...proposed } = op as Record<string, unknown> & { type: string };
      const snap = (stored[i] ?? null) as Record<string, unknown> | null;
      const now = (live[i] ?? null) as Record<string, unknown> | null;

      // One RenderedChange per field the operation touches.
      //
      // The key set is the UNION of the proposed keys and the SNAPSHOT keys — not the proposed keys
      // alone. This is what makes the two PURELY DESTRUCTIVE operations render at all: `frequency.clear`
      // and `progress.delete` propose no values, so a proposed-keys-only walk yields `changes: []` and
      // the banner shows an operation with nothing under it — asking the owner to consent to a blank.
      // Taking the union, their snapshot fields appear with `after: null`, which reads correctly as
      // "this value goes away". Identity fields (`entryId`, `task`) are the TARGET, not a change, and
      // are excluded — they are already in `targetLabel`.
      const keys = [...new Set([...Object.keys(proposed), ...Object.keys(snap ?? {})])].filter(
        (k) => !IDENTITY_KEYS.has(k),
      );

      const changes: RenderedChange[] = [];
      for (const key of keys) {
        const snapValue = snap ? snap[key] : undefined;
        const liveValue = now ? now[key] : undefined;
        // A key present in the snapshot but absent from `proposed` is being CLEARED by a destructive
        // operation → after is null. (For a PATCH-style update, an absent key means "unchanged" and is
        // never in the snapshot in the first place — the snapshot captures only the touched fields.)
        const afterValue = key in proposed ? proposed[key] : null;
        // Stale = the record drifted under the proposal for THIS field (spec 5.5.3).
        const isStale = JSON.stringify(snapValue ?? null) !== JSON.stringify(liveValue ?? null);
        changes.push({
          field: fieldLabel(key, locale),
          // When stale, `before` is the LIVE value — never the stale snapshot rendered as current.
          before: await this.formatField(proposal.ownerId, key, isStale ? liveValue : snapValue, locale),
          after: await this.formatField(proposal.ownerId, key, afterValue, locale),
          ...(isStale
            ? { stale: { atProposeTime: await this.formatField(proposal.ownerId, key, snapValue, locale) } }
            : {}),
        });
      }

      rendered.push({
        type: op.type,
        targetLabel: await this.label(proposal.plantId, proposal.ownerId, op, locale),
        changes,
        destructive: op.type === 'progress.delete',
      });
    }

    return {
      id: proposal.id,
      status: proposal.status,
      autoApproved: proposal.autoApproved,
      failureCode: proposal.failureCode,
      failureReason: proposal.failureReason,
      createdAt: proposal.createdAt,
      operations: rendered,
      summary: proposal.summary,
    };
  }

  /**
   * Render ONE field value, resolving any value that is an ID into the name the owner recognises.
   *
   * `placeId` is the case that matters: showing `before: "clx7k2..." → after: "clx9m4..."` is not consent,
   * it is a hash the owner cannot evaluate — and "move the plant" is one of the more consequential
   * operations. Resolution is OWNER-SCOPED, so a foreign place can never render as a name; an
   * unresolvable id falls back to the id itself rather than to a blank the owner would read as "nowhere".
   */
  private async formatField(ownerId: string, key: string, value: unknown, locale: Locale): Promise<string | null> {
    if (value === undefined || value === null) return null;
    if (key === 'placeId') {
      // A place NAME is the user's own data (a proper noun), never a server-owned vocabulary member —
      // `locale` plays no role in this branch, on purpose.
      const place = await this.prisma.place.findFirst({ where: { id: String(value), ownerId } });
      return place?.name ?? String(value);
    }
    return formatValue(value, locale, key);
  }

  /**
   * EVERY lookup here is scoped by the proposal's own plant/owner. This is not defensive style — an
   * unscoped `findFirst({ where: { id: op.placeId } })` would resolve and RENDER another owner's place
   * name into this owner's banner, leaking a foreign record through the consent surface. The proposal
   * row carries `plantId` and `ownerId` precisely so no query here has to guess the scope.
   */
  private async label(plantId: string, ownerId: string, op: ProposalOperation, locale: Locale): Promise<string> {
    switch (op.type) {
      case 'frequency.set':
      case 'frequency.clear':
      case 'care.done':
        // Both locales resolve the task to its NAME. The fallback to the raw enum is the same
        // never-blank rule every other lookup here follows: an unknown member reads as something the
        // owner can still recognise rather than vanishing from the operation's header.
        return (TASK_LABELS[locale] ?? TASK_LABELS.en)[op.task] ?? op.task;
      case 'progress.update':
      case 'progress.delete': {
        const entry = await this.prisma.plantProgressEntry.findFirst({ where: { id: op.entryId, plantId } });
        // A calendar date is locale-invariant; an unresolved entryId is a raw id in both locales.
        return entry ? ymdFromUtcDate(entry.occurredOn) : op.entryId;
      }
      case 'plant.update': {
        if (op.placeId) {
          // Owner-scoped: a place belonging to anyone else must never resolve to a name. A place NAME is
          // never translated — it is the owner's own data, not a server vocabulary member.
          const place = await this.prisma.place.findFirst({ where: { id: op.placeId, ownerId } });
          return place?.name ?? op.placeId;
        }
        return locale === 'es' ? TARGET_LABEL_LITERALS_ES.nickname : 'nickname';
      }
      case 'profile.update':
        return locale === 'es' ? TARGET_LABEL_LITERALS_ES.profile : 'profile';
      case 'progress.create':
        return locale === 'es' ? TARGET_LABEL_LITERALS_ES['new progress entry'] : 'new progress entry';
    }
  }
}
