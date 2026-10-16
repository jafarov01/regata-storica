import express from 'express';
// express 5: the old '*' route must throw; '/{*splat}' must work.
try {
  const a = express();
  a.get('*', (_req, res) => { res.send('x'); });
  console.log('"*" accepted (unexpected)');
} catch (e) {
  console.log('"*" throws:', (e as Error).message);
}
try {
  const b = express();
  b.get('/{*splat}', (_req, res) => { res.send('x'); });
  b.get('/*splat', (_req, res) => { res.send('x'); });
  console.log('"/{*splat}" and "/*splat" accepted');
} catch (e) {
  console.log('wildcard throws:', (e as Error).message);
}
