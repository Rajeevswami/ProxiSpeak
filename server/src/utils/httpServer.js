/**
 * HTTP server helpers for the boot sequence.
 *
 * `server.listen()` reports a failure by emitting an 'error' event, and an
 * unhandled 'error' event is an uncaught exception: the most common local
 * mistake — a previous server still holding the port — used to print a raw
 * stack trace from inside node:net. Boot failures are logged as one actionable
 * line everywhere else (see server/src/index.js), so the port gets the same
 * treatment.
 */

/**
 * @param {import('node:http').Server} server
 * @param {{port:number, host:string}} options
 * @returns {Promise<void>} resolves once listening, rejects with an actionable Error
 */
export function listenOn(server, { port, host }) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      // Only the cases the operator can act on get advice; anything else keeps
      // its original message.
      const hint =
        err?.code === 'EADDRINUSE'
          ? ' — another process (an older run of this server?) is already using it, so change PORT or stop that process'
          : err?.code === 'EACCES'
            ? ' — that port needs privileges, so use a port above 1024'
            : '';
      reject(new Error(`cannot listen on ${host}:${port} (${err?.code ?? 'error'}): ${err?.message ?? err}${hint}`));
    };

    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

export default listenOn;
