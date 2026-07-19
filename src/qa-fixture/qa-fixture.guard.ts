/**
 * The environment guard for the destructive QA fixture reset.
 *
 * Kept apart from the script so it is unit-testable: a guard nobody can test is a guard nobody has
 * verified, and this one is the only thing standing between `npm run qa:reset` and a production
 * database. It is FAIL-CLOSED — anything other than an explicit `development` refuses.
 */

export class EnvironmentGuardError extends Error {}

export function assertDevelopmentEnv(source: NodeJS.ProcessEnv = process.env): void {
  const appEnv = source.APP_ENV;

  if (appEnv === 'development') return;

  const seen = appEnv === undefined || appEnv === '' ? '<unset>' : appEnv;
  throw new EnvironmentGuardError(
    `Refusing to run: this command DESTROYS and rebuilds data, and APP_ENV is ${seen}.\n` +
      `It runs only when APP_ENV is explicitly "development".\n\n` +
      `If this really is your local machine, add APP_ENV=development to the API's .env file.\n` +
      `If you are on the production server, you are in the wrong place — stop.`,
  );
}
