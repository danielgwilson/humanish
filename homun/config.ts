export default {
  schema: "homun.config.v1",
  app: {
    name: "homun",
    baseUrl: "file://README.md",
    startCommand: "pnpm homun -- --help"
  },
  personasDir: "homun/personas",
  scenariosDir: "homun/scenarios",
  policiesDir: "homun/policies",
  artifactsDir: ".homun/runs"
};
