import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { createPool } from "../db/client.js";
import { listTenants } from "../tenants/queries.js";
import {
  addNumberCommand,
  createTenantCommand,
  createUserCommand,
  resetPasswordCommand,
} from "./commands.js";

const USAGE = `Usage:
  cli create-tenant --name <name> --slug <slug>
  cli create-user --email <email> (--tenant <slug> | --platform-admin)
  cli reset-password --email <email>
  cli list-tenants
  cli add-number --e164 <+E164> [--telnyx-id <id>] [--tenant <slug>]
`;

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      name: { type: "string" },
      slug: { type: "string" },
      email: { type: "string" },
      tenant: { type: "string" },
      e164: { type: "string" },
      "telnyx-id": { type: "string" },
      "platform-admin": { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  const pool = createPool(loadConfig(process.env));

  try {
    switch (command) {
      case "create-tenant": {
        if (!values.name || !values.slug) throw new Error("--name and --slug are required");
        const tenant = await createTenantCommand(pool, {
          name: values.name,
          slug: values.slug,
        });
        console.log(`created tenant ${tenant.slug} (${tenant.id})`);
        break;
      }
      case "create-user": {
        if (!values.email) throw new Error("--email is required");
        const created = await createUserCommand(pool, {
          email: values.email,
          tenantSlug: values.tenant ?? null,
          platformAdmin: values["platform-admin"] === true,
        });
        console.log(`created ${created.role} ${created.email}`);
        console.log(`password: ${created.password}`);
        console.log("This password is shown once and is not recoverable.");
        break;
      }
      case "reset-password": {
        if (!values.email) throw new Error("--email is required");
        const reset = await resetPasswordCommand(pool, { email: values.email });
        console.log(`password for ${reset.email}: ${reset.password}`);
        console.log("This password is shown once and is not recoverable.");
        break;
      }
      case "add-number": {
        if (!values.e164) throw new Error("--e164 is required");
        const number = await addNumberCommand(pool, {
          e164: values.e164,
          telnyxId: values["telnyx-id"] ?? null,
          tenantSlug: values.tenant ?? null,
        });
        console.log(
          `added ${number.e164} (${number.tenantSlug ?? "shared pool"})`,
        );
        break;
      }
      case "list-tenants": {
        for (const tenant of await listTenants(pool)) {
          console.log(`${tenant.slug}\t${tenant.name}\t${tenant.id}`);
        }
        break;
      }
      default:
        console.log(USAGE);
        process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

await main();
