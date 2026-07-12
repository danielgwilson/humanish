export const appAdapter = {
  schema: "humanish.adapter.v1",
  id: "humanish",
  name: "Humanish CLI",
  routes: [
    {
      id: "help",
      path: "humanish --help",
      description: "Top-level Commander help and public-safety boundary."
    },
    {
      id: "init",
      path: "humanish init --dry-run --json",
      description: "Safe target repo setup preview."
    },
    {
      id: "dry-run",
      path: "humanish run --dry-run --json",
      description: "Synthetic run bundle generation."
    },
    {
      id: "observer",
      path: "humanish watch",
      description: "One-command self-run, Observer render, browser open, and shell watch."
    },
    {
      id: "feedback",
      path: "humanish feedback issue --run latest --repo danielgwilson/humanish --format markdown",
      description: "Public-safe issue draft generation without GitHub mutation."
    }
  ]
};
