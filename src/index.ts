/**
 * x402 Facilitator — server entry point.
 *
 * Routing:
 *   /api/health                 public
 *   /api/discovery/*            public (scope = Host → configuration)
 *   /api/admin/*                UserPrincipal (JWT; X402_ADMIN_JWT_SECRET / _JWKS_URL)
 *   /api/payments/*             ApiTokenPrincipal (bearer API key)
 *                               scope = principal.configurationId (immutable)
 *
 * This facilitator is API-only. Merchants integrate via middleware/SDK
 * on their own servers, calling /api/payments/verify + /api/payments/settle.
 */

import express, { Request, Response, NextFunction } from 'express';
import { randomBytes } from 'crypto';
import dotenv from 'dotenv';
import cors from 'cors';
import helmet from 'helmet';

import { ConfigFile, resolveConfigPath, setConfigFile } from './config/configFile';
import {
  JsonFacilitatorRepository,
  JsonAssetRepository,
  JsonProductRepository,
  JsonApiTokenRepository,
} from './repositories/json';
import { createPaymentRepository } from './repositories/payment';
import { DefaultConfigurationResolver } from './core/configurationResolver';
import { createUserAuthenticator } from './auth/userAuthenticator';
import { FireblocksSettlementFactory } from './services/fireblocksSettlementFactory';
import {
  PricingService,
  NoopGasCostEstimator,
  createDefaultPriceProvider,
} from './services/pricing';
import { createMechanismRegistry } from './mechanisms';
import {
  createApiTokenAuthMiddleware,
  createUserAuthMiddleware,
  createAdminScopeMiddleware,
  createApiTokenScopeMiddleware,
} from './middleware/auth';
import { createPaymentRoutes } from './routes/payments';
import { createDiscoveryRoutes } from './routes/discovery';
import { createProductRoutes } from './routes/products';
import { createFacilitatorRoutes } from './routes/facilitator';
import { createAdminTokenRoutes } from './routes/adminTokens';
import { createAdminPaymentRoutes } from './routes/adminPayments';
import { createAdminAssetRoutes } from './routes/adminAssets';
import { createAdminFireblocksRoutes } from './routes/adminFireblocks';
import { createWellKnownRoutes } from './routes/wellKnown';
import { IntegritySignerFactory } from './services/integrity/IntegritySigner';
import { resolveHs256Secret } from './auth/jwtSecret';
import { findMainnetAssets, mainnetAllowed, MainnetAssetForbiddenError } from './config/networkPolicy';
import { ListAssetsFireblocksCatalog } from './services/assets';
import { PaymentReconciler } from './services/reconciliation/PaymentReconciler';

dotenv.config();

type Role = 'all' | 'processing' | 'management';

function resolveRole(): Role {
  const raw = (process.env.X402_ROLE || 'all').toLowerCase();
  if (raw === 'all' || raw === 'processing' || raw === 'management') return raw;
  throw new Error(`Invalid X402_ROLE='${raw}'. Must be one of: all | processing | management`);
}

async function main() {
  const PORT = Number(process.env.PORT || 3000);
  const ROLE = resolveRole();
  const isProcessing = ROLE === 'all' || ROLE === 'processing';
  const isManagement = ROLE === 'all' || ROLE === 'management';

  // ── Config ─────────────────────────────────────────────────────────
  const configFile = new ConfigFile(resolveConfigPath());
  setConfigFile(configFile);
  const top = configFile.get(); // parse + validate at boot

  // Mainnet policy — default-deny. Scan assets; fail if any mainnet entry
  // exists while the flag is off.
  const mainnetAssets = findMainnetAssets(top.assets);
  if (mainnetAssets.length > 0 && !mainnetAllowed()) {
    throw new MainnetAssetForbiddenError(mainnetAssets, 'boot');
  }

  // ── Repositories ───────────────────────────────────────────────────
  const facilitatorRepo = new JsonFacilitatorRepository(configFile);
  const assetRepo = new JsonAssetRepository(configFile);
  const productRepo = new JsonProductRepository(configFile);
  const apiTokenRepo = new JsonApiTokenRepository(configFile);
  const paymentRepo = await createPaymentRepository();

  // ── Services ───────────────────────────────────────────────────────
  const resolver = new DefaultConfigurationResolver(configFile);
  const userAuth = createUserAuthenticator();
  const fireblocksFactory = new FireblocksSettlementFactory(facilitatorRepo);
  const mechanismRegistry = createMechanismRegistry(fireblocksFactory);
  const priceProvider = createDefaultPriceProvider();
  const gasCostEstimator = new NoopGasCostEstimator();
  const pricing = new PricingService(assetRepo, priceProvider, gasCostEstimator);
  const integrityFactory = new IntegritySignerFactory();
  const assetCatalog = new ListAssetsFireblocksCatalog(facilitatorRepo);
  const reconciler = new PaymentReconciler(paymentRepo, fireblocksFactory);

  // ── Middleware factories ───────────────────────────────────────────
  const apiTokenAuth = createApiTokenAuthMiddleware(apiTokenRepo);
  const userAuthMw = createUserAuthMiddleware(userAuth);
  const adminScope = createAdminScopeMiddleware(resolver);
  const apiTokenScope = createApiTokenScopeMiddleware(resolver);

  // ── Express app ────────────────────────────────────────────────────
  const app = express();
  const allowedOrigins =
    process.env.ALLOWED_ORIGINS?.split(',') || [`http://localhost:${PORT}`];
  app.use(cors({ origin: allowedOrigins, credentials: true }));
  app.use(
    helmet({
      contentSecurityPolicy: process.env.NODE_ENV === 'development' ? false : undefined,
      strictTransportSecurity:
        process.env.NODE_ENV === 'development' ? false : undefined,
      crossOriginOpenerPolicy:
        process.env.NODE_ENV === 'development' ? false : undefined,
      originAgentCluster: process.env.NODE_ENV === 'development' ? false : undefined,
    }),
  );
  app.use(express.json());

  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    const reqId = `${Date.now()}-${randomBytes(4).toString('hex')}`;
    console.log(`📥 [${reqId}] ${req.method} ${req.path}`);
    res.on('finish', () => {
      console.log(
        `📤 [${reqId}] ${req.method} ${req.path} → ${res.statusCode} (${Date.now() - start}ms)`,
      );
    });
    next();
  });

  // ── Health: always available ──────────────────────────────────────
  app.get('/api/health', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      role: ROLE,
      mechanisms: mechanismRegistry.getAvailable(),
      timestamp: new Date().toISOString(),
    });
  });

  // ── Public: .well-known/did.json (optional) ──────────────────────
  // Always mounted; the route internally 404s when the matched
  // configuration has integrity disabled or serve_did_document=false.
  app.use('/.well-known', createWellKnownRoutes(configFile, resolver, integrityFactory));

  // ── Processing-role routes ────────────────────────────────────────
  if (isProcessing) {
    app.use(
      '/api/discovery',
      createDiscoveryRoutes(facilitatorRepo, assetRepo, productRepo, resolver),
    );

    // /supported is public; the router reads req.scope which we set from
    // the Host → configuration resolver in that case.
    app.use(
      '/api/payments',
      (req: Request, res: Response, next: NextFunction) => {
        if (req.path === '/supported') {
          req.scope = resolver.fromProxyRequest(req) ?? resolver.defaultScope();
          return next();
        }
        apiTokenAuth(req, res, (err?: any) => {
          if (err) return next(err);
          apiTokenScope(req, res, next);
        });
      },
      createPaymentRoutes({
        facilitator: facilitatorRepo,
        assets: assetRepo,
        products: productRepo,
        payments: paymentRepo,
        mechanismRegistry,
        fireblocksFactory,
        pricing,
        integrityFactory,
        configFile,
      }),
    );

  }

  // ── Management-role routes ────────────────────────────────────────
  if (isManagement) {
    const adminChain = [userAuthMw, adminScope];
    app.use('/api/admin/facilitator', ...adminChain, createFacilitatorRoutes(facilitatorRepo));
    app.use(
      '/api/admin/assets',
      ...adminChain,
      createAdminAssetRoutes(assetRepo, configFile, assetCatalog),
    );
    app.use(
      '/api/admin/products',
      ...adminChain,
      createProductRoutes(productRepo, assetRepo, configFile),
    );
    app.use('/api/admin/tokens', ...adminChain, createAdminTokenRoutes(apiTokenRepo));
    app.use(
      '/api/admin/payments',
      ...adminChain,
      createAdminPaymentRoutes(paymentRepo, assetRepo, productRepo, fireblocksFactory, reconciler),
    );
    app.use('/api/admin/fireblocks', ...adminChain, createAdminFireblocksRoutes(configFile));
  }

  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('Unhandled error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  });

  // ── Boot reconciliation ───────────────────────────────────────────
  // Resume payments stuck in `settling` from a prior crash: query
  // Fireblocks by persisted tx id and drive the row to its real state.
  // Processing-role only — the management-only instance has no mechanism
  // layer and doesn't own payment lifecycle.
  // Opt out by setting X402_RECONCILE_ON_BOOT=false (operators running
  // many instances against the same store may want exactly one leader
  // to do the pass).
  const reconcileOnBoot = (process.env.X402_RECONCILE_ON_BOOT || 'true').toLowerCase() !== 'false';
  if (isProcessing && reconcileOnBoot) {
    for (const configuration of top.configurations) {
      const scope = { tenantId: top.tenant_id, configurationId: configuration.configuration_id };
      try {
        const summary = await reconciler.reconcileOpen(scope);
        if (summary.scanned > 0) {
          console.log(
            `[reconciler] ${configuration.configuration_id}: scanned=${summary.scanned} completed=${summary.completed} failed=${summary.failed} in_flight=${summary.inFlight} skipped=${summary.skipped}`,
          );
        }
      } catch (err) {
        console.error(`[reconciler] boot pass failed for ${configuration.configuration_id}:`, err);
      }
    }
  }

  const server = app.listen(PORT, () => {
    const top = configFile.get();
    // Probe the same resolution order the UserAuthenticator uses so
    // the banner reflects what's actually active.
    let adminStatus = 'DISABLED — run `x402 init` to scaffold a signing secret';
    if (process.env.X402_ADMIN_JWT_JWKS_URL) {
      adminStatus = `JWT via JWKS (${process.env.X402_ADMIN_JWT_JWKS_URL})`;
    } else {
      try {
        const resolved = resolveHs256Secret();
        if (resolved) {
          adminStatus = `JWT HS256 (secret from ${
            resolved.source === 'env' ? 'X402_ADMIN_JWT_SECRET env' : resolved.path
          })`;
        }
      } catch (err) {
        adminStatus = `DISABLED — secret file error: ${(err as Error).message}`;
      }
    }
    console.log(`x402 Facilitator listening on ${PORT}`);
    console.log(`  role:              ${ROLE}`);
    console.log(`  tenant_id:         ${top.tenant_id}`);
    console.log(`  default_config:    ${top.default_configuration_id}`);
    console.log(
      `  configurations:    ${top.configurations.map((c) => c.configuration_id).join(', ')}`,
    );
    console.log(`  mechanisms:        ${mechanismRegistry.getAvailable().join(', ')}`);
    const assetCount = top.assets.length;
    const testnetCount = top.assets.filter((a) => a.is_testnet).length;
    console.log(
      `  network policy:    ${mainnetAllowed() ? 'mainnet OK (X402_ALLOW_MAINNET=true)' : 'testnet-only (default)'} · ${assetCount} asset(s), ${testnetCount} testnet`,
    );
    if (isProcessing) {
      console.log(
        `  reconcile-on-boot: ${reconcileOnBoot ? 'on (default)' : 'off (X402_RECONCILE_ON_BOOT=false)'}`,
      );
    }
    if (isManagement) {
      console.log(`  admin auth:        ${adminStatus}`);
    }
  });

  const shutdown = async (signal: string) => {
    console.log(`${signal} received, shutting down...`);
    server.close();
    if (paymentRepo.close) await paymentRepo.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
