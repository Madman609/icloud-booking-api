export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({
    ok: true,
    hasEnv: {
      user: !!process.env.ICLOUD_USERNAME,
      pass: !!process.env.ICLOUD_APP_PASSWORD
    }
  });
}
