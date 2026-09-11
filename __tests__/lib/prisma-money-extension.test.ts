/**
 * #780 drift guard — every BigInt column in the schema must appear in the
 * lib/prisma-extensions.ts result-extension map. A new money column left out of it
 * would leak `bigint` past the JS boundary (JSON.stringify throws, arithmetic
 * silently mixes types). Source-parses both files so the check needs no DB.
 */
import fs from "fs";
import path from "path";

const root = path.join(__dirname, "..", "..");
const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
const client = fs.readFileSync(
  path.join(root, "lib", "prisma-extensions.ts"),
  "utf8",
);

function bigIntFields(): Array<{ model: string; field: string }> {
  const out: Array<{ model: string; field: string }> = [];
  const modelRe = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let m: RegExpExecArray | null;
  while ((m = modelRe.exec(schema))) {
    const [, name, body] = m;
    const fieldRe = /^\s*(\w+)\s+BigInt\??/gm;
    let f: RegExpExecArray | null;
    while ((f = fieldRe.exec(body))) out.push({ model: name, field: f[1] });
  }
  return out;
}

// Prisma client model property = model name with the first letter lowered
// (TDSRecord → tDSRecord).
const clientKey = (model: string) => model[0].toLowerCase() + model.slice(1);

describe("#780 money-boundary extension drift", () => {
  it("finds BigInt columns in the schema at all", () => {
    expect(bigIntFields().length).toBeGreaterThanOrEqual(84);
  });

  it("covers every BigInt column in the extension map", () => {
    const missing = bigIntFields().filter(({ model, field }) => {
      const entry = new RegExp(
        `${clientKey(model)}:\\s*\\{[^}]*\\b${field}:\\s*fn?\\("${field}"\\)`,
      );
      return !entry.test(client);
    });
    expect(missing).toEqual([]);
  });
});
