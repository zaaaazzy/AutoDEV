// Einstieg für `npm run dev`: eigener Port und Schutz vor der Live-Datenbank, danach der normale Server.
import { DEV_API_PORT, devEnvironmentProblem } from './core/dev-environment.js';

process.env.PORT ||= String(DEV_API_PORT);
const problem = devEnvironmentProblem(process.env);
if (problem) {
  console.error(`AIdeation (dev) startet nicht: ${problem}`);
  process.exitCode = 1;
} else {
  void import('./server.js');
}
