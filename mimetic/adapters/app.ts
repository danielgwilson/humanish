export const appAdapter = {
  schema: "mimetic.adapter.v1",
  id: "mimetic-cli",
  name: "Mimetic CLI",
  routes: [
    {
      id: "help",
      path: "mimetic --help",
      description: "Top-level Commander help and public-safety boundary."
    },
    {
      id: "init",
      path: "mimetic init --dry-run --json",
      description: "Safe target repo setup preview."
    },
    {
      id: "dry-run",
      path: "mimetic run --dry-run --json",
      description: "Synthetic run bundle generation."
    },
    {
      id: "observer",
      path: "mimetic watch",
      description: "One-command self-run, Observer render, browser open, and shell watch."
    },
    {
      id: "feedback",
      path: "mimetic feedback issue --run latest --repo danielgwilson/mimetic-cli --format markdown",
      description: "Public-safe issue draft generation without GitHub mutation."
    }
  ]
};
