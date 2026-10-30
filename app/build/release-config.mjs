export const feed = { provider: "github", owner: "JonathanRReed", repo: "Simple-md" };
export const repository = `${feed.owner}/${feed.repo}`;
export const releaseVersion = value => {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new Error("Use a stable version such as 1.0.0.");
  return value;
};
export function releaseConfig(plan, output) {
  return {
    directories: { output },
    artifactName: "SimpleMD-${version}-${os}-${arch}.${ext}",
    publish: [feed],
    extraResources: [
      { from: plan.binary, to: `native/${plan.executable}` },
      { from: plan.cliBinary, to: `native/${plan.cliExecutable}` },
    ],
  };
}
