/**
 * Сборка сервисов поверх ядра. Сервисы не знают про MCP и транспорт: их
 * одинаково используют инструменты, CLI и фоновые воркеры.
 */
import { AccessPolicy } from '../policy/access.js';
import { Audit } from '../policy/audit.js';
import { ScopePolicy } from '../policy/scopes.js';
import type { Runtime } from '../runtime.js';
import { CommentsService } from './comments.js';
import { ExportService } from './export.js';
import { HistoryService } from './history.js';
import { JobManager } from './jobs.js';
import { MediaService } from './media.js';
import { Resolver } from './resolve.js';
import { SearchService } from './search.js';
import { TopicsService } from './topics.js';

export interface GatewayServices {
  runtime: Runtime;
  access: AccessPolicy;
  scopes: ScopePolicy;
  audit: Audit;
  resolver: Resolver;
  history: HistoryService;
  search: SearchService;
  comments: CommentsService;
  topics: TopicsService;
  media: MediaService;
  exporter: ExportService;
  jobs: JobManager;
}

export function buildServices(runtime: Runtime, now: () => number = () => Date.now()): GatewayServices {
  const { tg, storage, config, log } = runtime;
  const history = new HistoryService(tg);
  const search = new SearchService(tg, storage.entities);
  const media = new MediaService({ tg, filesDir: config.filesDir, log: log.child('media'), now });
  const exporter = new ExportService({ storage, history, search, media, filesDir: config.filesDir, now });
  const jobs = new JobManager({ storage, log: log.child('jobs') });
  jobs.register('export', context => exporter.run(context));

  return {
    runtime,
    access: new AccessPolicy(storage),
    scopes: new ScopePolicy(storage),
    audit: new Audit(storage, now, log.child('audit')),
    resolver: new Resolver({ tg, entities: storage.entities, now }),
    history,
    search,
    comments: new CommentsService(tg, storage.entities),
    topics: new TopicsService(tg),
    media,
    exporter,
    jobs,
  };
}
