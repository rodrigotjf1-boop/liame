import { Global, Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { APP_CONFIG, type AppConfig, loadConfig } from '../config.js';
import { UnitOfWorkInterceptor } from '../context/unit-of-work.interceptor.js';
import { PolicyInterceptor } from '../policy/politica.js';
import { PolicyService } from '../policy/policy.service.js';
import { createMailer, Mailer } from '../mail/mailer.js';
import { AccessGuard } from './access.guard.js';
import { AuthController, MeController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { InvitationAcceptService } from './invitation-accept.service.js';
import { InvitationController } from './invitation.controller.js';
import { LegalController } from './legal.controller.js';
import { SecurityController } from './security.controller.js';
import { SecurityService } from './security.service.js';
import { MfaController } from './mfa.controller.js';
import { MfaService } from './mfa.service.js';
import { RateLimitService } from './rate-limit.service.js';
import { SessionService } from './session.service.js';

@Global()
@Module({
  controllers: [AuthController, MeController, MfaController, InvitationController, LegalController, SecurityController],
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig() },
    {
      provide: Mailer,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createMailer(config),
    },
    SessionService,
    RateLimitService,
    AuthService,
    MfaService,
    InvitationAcceptService,
    SecurityService,
    { provide: APP_GUARD, useClass: AccessGuard },
    { provide: APP_INTERCEPTOR, useClass: UnitOfWorkInterceptor },
    // Depois da unidade de trabalho: a política é avaliada dentro da transação da requisição.
    PolicyService,
    { provide: APP_INTERCEPTOR, useClass: PolicyInterceptor },
  ],
  exports: [APP_CONFIG, Mailer, SessionService, RateLimitService, PolicyService, MfaService],
})
export class AuthModule {}
