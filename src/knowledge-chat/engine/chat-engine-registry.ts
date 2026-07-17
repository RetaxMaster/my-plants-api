import { Inject, Injectable } from '@nestjs/common';
import type { ChatEngine } from './knowledge-chat-engine.service.js';
import { KNOWLEDGE_ENGINE, DOCTOR_ENGINE } from './engine-params.js';

// The single point that maps a session's kind → the engine that runs it and the log dir its runs live in.
// The shared service asks the registry; it never reaches for a specific engine or a specific log dir env
// var directly. Adding a third engine kind is a change HERE and in engine-params — nowhere else.
@Injectable()
export class ChatEngineRegistry {
  constructor(
    @Inject(KNOWLEDGE_ENGINE) private readonly knowledge: ChatEngine,
    @Inject(DOCTOR_ENGINE) private readonly doctor: ChatEngine,
  ) {}

  engineFor(kind: 'KNOWLEDGE' | 'DOCTOR'): ChatEngine {
    return kind === 'DOCTOR' ? this.doctor : this.knowledge;
  }

  logDirFor(kind: 'KNOWLEDGE' | 'DOCTOR'): string {
    return this.engineFor(kind).logDir;
  }
}
