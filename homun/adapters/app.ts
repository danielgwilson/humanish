export const appAdapter = {
  schema: "homun.adapter.v1",
  id: "homun",
  name: "Homun CLI",
  routes: [
    {
      id: "help",
      path: "homun --help",
      description: "Top-level Commander help and public-safety boundary."
    },
    {
      id: "init",
      path: "homun init --dry-run --json",
      description: "Safe target repo setup preview."
    },
    {
      id: "dry-run",
      path: "homun run --dry-run --json",
      description: "Synthetic run bundle generation."
    },
    {
      id: "observer",
      path: "homun watch",
      description: "One-command self-run, Observer render, browser open, and shell watch."
    },
    {
      id: "feedback",
      path: "homun feedback issue --run latest --repo danielgwilson/homun --format markdown",
      description: "Public-safe issue draft generation without GitHub mutation."
    }
  ]
};
