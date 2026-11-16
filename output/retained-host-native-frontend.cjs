// Separate replaceable process; all command parsing uses the production frontend.
const { RetainedFrontend } = require('/app/dist/sessionHost/RetainedFrontend');
let frontend;
process.on('message', async message => {
  try {
    let value;
    if (message.action === 'start') {
      frontend = new RetainedFrontend({ connect: async () => message.connection }, message.version);
      await frontend.start(); value = { pid: process.pid, ...frontend.status() };
    } else if (message.action === 'prepare') {
      if (!frontend.tryBeginAutomaticUpdate()) throw Error('Frontend update admission failed: '+JSON.stringify(frontend.status()));
      await frontend.prepareAutomaticUpdate(); value = frontend.status();
    } else if (message.action === 'close') {
      await frontend.close(); value = { detached: true };
    } else if (message.action === 'status') value = frontend.status();
    else throw Error('Unknown fixture request');
    process.send({ id: message.id, value }, () => { if (message.action === 'close') process.exit(0); });
  } catch (error) { process.send({ id: message.id, error: error.message }); }
});
