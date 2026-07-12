export default {
  schema: "humanish.config.v1",
  app: {
    name: "humanish",
    baseUrl: "file://README.md",
    startCommand: "pnpm humanish -- --help"
  },
  personasDir: "humanish/personas",
  scenariosDir: "humanish/scenarios",
  policiesDir: "humanish/policies",
  artifactsDir: ".humanish/runs"
};
