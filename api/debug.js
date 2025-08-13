export const config = { runtime: 'nodejs' };
import fs from 'node:fs/promises';
export default async function handler(req, res) {
  try {
    const text = await fs.readFile(process.cwd() + '/package.json', 'utf8');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send(text);
  } catch (e) {
    res.status(500).send(String(e));
  }
}
