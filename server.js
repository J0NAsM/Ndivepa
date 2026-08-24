/**
 * Punto de entrada de Ndivepa.
 *
 * Antes este fichero contenía el servidor, la API, el dominio y la persistencia en
 * 23 líneas minificadas. Ahora solo arranca la aplicación y gestiona el apagado
 * ordenado; todo lo demás vive en `src/`.
 *
 * - Arquitectura: `.context/Arquitectura.md`
 * - Plan y backlog: `.context/Plan_Maestro.md`, `.context/Backlog_Mejoras.md`
 */
import { start } from './src/app.js';

const app = await start();

/** Apagado ordenado: cerrar conexiones y vaciar la cola de escritura (M-0197, M-1027). */
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.logger.info('Apagando Ndivepa', { signal });
  try {
    await app.shutdown();
    app.logger.info('Apagado completado. Los datos quedaron persistidos.');
  } catch (error) {
    app.logger.error('Fallo durante el apagado', error);
    process.exitCode = 1;
  }
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    shutdown(signal).then(() => process.exit(process.exitCode ?? 0));
  });
}

// Un fallo no controlado se registra con contexto en lugar de morir en silencio (M-0198).
process.on('unhandledRejection', reason => {
  app.logger.error('Promesa rechazada sin manejar', reason instanceof Error ? reason : { reason: String(reason) });
});
process.on('uncaughtException', error => {
  app.logger.error('Excepción no capturada', error);
  shutdown('uncaughtException').then(() => process.exit(1));
});
