export default {
  schema: "mimetic.config.v1",
  app: {
    name: "mimetic-cli",
    baseUrl: "file://README.md",
    startCommand: "pnpm mimetic -- --help"
  },
  personasDir: "mimetic/personas",
  scenariosDir: "mimetic/scenarios",
  policiesDir: "mimetic/policies",
  artifactsDir: ".mimetic/runs"
};
