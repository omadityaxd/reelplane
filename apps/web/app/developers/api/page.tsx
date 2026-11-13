import type { Metadata } from "next";
import Link from "next/link";
import { buildOpenApi } from "@/lib/server/openapi/spec.ts";
import "../../dashboard/dashboard.css";

export const metadata: Metadata = { title: "Reelplane API reference" };
export const dynamic = "force-static";

/**
 * The API reference, rendered from the same OpenAPI document as /openapi.json (which is built
 * from the routes themselves; see lib/server/openapi/spec.ts), so the two cannot disagree.
 */
type Schema = {
  type?: string | string[];
  $ref?: string;
  anyOf?: Schema[];
  items?: Schema;
  enum?: unknown[];
  format?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  description?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  maxItems?: number;
};
type Parameter = {
  name: string;
  in: string;
  required: boolean;
  description?: string;
  schema: Schema;
};
type OperationDoc = {
  operationId: string;
  tags: string[];
  summary: string;
  description: string;
  parameters?: Parameter[];
  requestBody?: { content: { "application/json": { schema: Schema } } };
  responses: Record<
    string,
    { description: string; content?: { "application/json": { schema: Schema } } }
  >;
  security: Record<string, unknown>[];
  "x-rate-limit"?: { limit: number; windowSeconds: number; per: string };
};

const CREDENTIALS: Record<string, string> = {
  secretKey: "secret key",
  publishableKey: "publishable key",
  publishableKeyQuery: "publishable key as ?key=",
  uploadToken: "upload token",
};

function typeOf(schema: Schema): string {
  if (schema.$ref) return schema.$ref.split("/").at(-1) ?? "object";
  if (schema.anyOf) return schema.anyOf.map(typeOf).join(" | ");
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  if (schema.type === "array" && schema.items) return `${typeOf(schema.items)}[]`;
  const type = Array.isArray(schema.type) ? schema.type.join(" | ") : (schema.type ?? "any");
  return schema.format ? `${type} (${schema.format})` : type;
}

function limits(schema: Schema): string {
  const notes: string[] = [];
  if (schema.minimum !== undefined) notes.push(`≥ ${schema.minimum}`);
  if (schema.maximum !== undefined) notes.push(`≤ ${schema.maximum}`);
  if (schema.maxLength !== undefined) notes.push(`≤ ${schema.maxLength} chars`);
  if (schema.maxItems !== undefined) notes.push(`≤ ${schema.maxItems} items`);
  if (schema.default !== undefined) notes.push(`default ${JSON.stringify(schema.default)}`);
  return [schema.description, notes.join(", ")].filter(Boolean).join(" · ");
}

function Fields({ rows }: { rows: { name: string; schema: Schema; required: boolean }[] }) {
  return (
    <div className="dash-table-wrap">
      <table className="dash-table">
        <thead>
          <tr>
            <th>Field</th>
            <th>Type</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name}>
              <td className="mono">
                {row.name}
                {row.required ? "" : "?"}
              </td>
              <td className="mono">{typeOf(row.schema)}</td>
              <td>{limits(row.schema)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function objectRows(schema: Schema) {
  return Object.entries(schema.properties ?? {}).map(([name, child]) => ({
    name,
    schema: child,
    required: schema.required?.includes(name) ?? false,
  }));
}

function OperationCard({ method, path, op }: { method: string; path: string; op: OperationDoc }) {
  const body = op.requestBody?.content["application/json"].schema;
  const params = op.parameters ?? [];
  const rate = op["x-rate-limit"];
  const credentials = op.security
    .flatMap((entry) => Object.keys(entry))
    .map((k) => CREDENTIALS[k] ?? k);
  return (
    <section className="dash-card" id={op.operationId} style={{ marginBottom: 16 }}>
      <h3 style={{ marginTop: 0 }}>
        <span className="dash-badge dash-badge--info">{method.toUpperCase()}</span>{" "}
        <code>{path}</code>
      </h3>
      <p>
        <strong>{op.summary}.</strong> {op.description}
      </p>
      <p className="dash-note">
        {credentials.length > 0 ? `Auth: ${credentials.join(" or ")}.` : "No credentials."}
        {rate ? ` Rate limit: ${rate.limit} per ${rate.windowSeconds} s per ${rate.per}.` : ""}
      </p>
      {params.length > 0 && (
        <>
          <h4>Parameters</h4>
          <Fields
            rows={params.map((p) => ({
              name: `${p.name} (${p.in})`,
              schema: { ...p.schema, description: p.description ?? p.schema.description },
              required: p.required,
            }))}
          />
        </>
      )}
      {body && (
        <>
          <h4>Body</h4>
          <Fields rows={objectRows(body)} />
        </>
      )}
      <h4>Responses</h4>
      <ul>
        {Object.entries(op.responses).map(([status, response]) => {
          const schema = response.content?.["application/json"].schema;
          const name = schema?.$ref?.split("/").at(-1);
          return (
            <li key={status}>
              <code>{status}</code> {response.description}
              {name && name !== "Error" && (
                <>
                  {" "}
                  <a href={`#schema-${name}`}>{name}</a>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default function ApiReferencePage() {
  const doc = buildOpenApi() as {
    info: { description: string };
    tags: { name: string; description: string }[];
    paths: Record<string, Record<string, OperationDoc>>;
    components: { schemas: Record<string, Schema> };
  };
  const operations = Object.entries(doc.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, op]) => ({ path, method, op })),
  );
  return (
    <div className="dash">
      <main className="dash-main" style={{ maxWidth: 860 }}>
        <p>
          <Link href="/developers">← Use Reelplane in your app</Link>
        </p>
        <h1>API reference</h1>
        <p className="dash-note">
          {doc.info.description} The machine-readable version is{" "}
          <a href="/openapi.json">/openapi.json</a> (OpenAPI 3.1).
        </p>
        <nav aria-label="Operations">
          <ul>
            {operations.map(({ path, method, op }) => (
              <li key={op.operationId}>
                <a href={`#${op.operationId}`}>
                  <code>
                    {method.toUpperCase()} {path}
                  </code>
                </a>{" "}
                {op.summary}
              </li>
            ))}
          </ul>
        </nav>
        {doc.tags.map((tag) => (
          <section key={tag.name}>
            <h2>{tag.name}</h2>
            <p className="dash-note">{tag.description}</p>
            {operations
              .filter(({ op }) => op.tags.includes(tag.name))
              .map(({ path, method, op }) => (
                <OperationCard key={op.operationId} method={method} path={path} op={op} />
              ))}
          </section>
        ))}
        <h2>Schemas</h2>
        {Object.entries(doc.components.schemas).map(([name, schema]) => (
          <section
            key={name}
            id={`schema-${name}`}
            className="dash-card"
            style={{ marginBottom: 16 }}
          >
            <h3 style={{ marginTop: 0 }}>{name}</h3>
            <Fields rows={objectRows(schema)} />
          </section>
        ))}
      </main>
    </div>
  );
}
