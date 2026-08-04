import fs from "fs";
import path from "path";

export type Deployment = Record<string, unknown> & { network: string };

const DIR = path.join(__dirname, "..", "deployments");

export function writeDeployment(network: string, record: Deployment) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, `${network}.json`), JSON.stringify(record, null, 2) + "\n");
}

export function readDeployment(network: string): Deployment {
  const file = path.join(DIR, `${network}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`no deployment for '${network}' — run: npx hardhat megapot:deploy --network ${network}`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
