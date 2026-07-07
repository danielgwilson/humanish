import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 4173);

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Homun Synthetic Fixture</title>
  </head>
  <body>
    <main>
      <h1>Homun Synthetic Fixture</h1>
      <p data-testid="state">first-visible-state</p>
      <form aria-label="Synthetic onboarding">
        <label>
          Synthetic email
          <input name="email" value="synthetic.user@example.test">
        </label>
        <button type="button" data-testid="continue">Continue</button>
      </form>
    </main>
    <script>
      document.querySelector('[data-testid="continue"]').addEventListener('click', () => {
        document.querySelector('[data-testid="state"]').textContent = 'second-visible-state';
      });
    </script>
  </body>
</html>`;

const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
});

server.listen(port, () => {
  console.log(`homun synthetic fixture listening on http://localhost:${port}`);
});
