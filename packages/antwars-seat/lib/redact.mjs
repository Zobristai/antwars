// Every byte the harness prints, logs or writes passes through redact(): a
// registered secret (the seat key) is replaced wherever it appears, including
// its JSON-escaped form.
const secrets = new Set();

export function addSecret(value) {
  if (typeof value === "string" && value.length >= 4) {
    secrets.add(value);
    secrets.add(JSON.stringify(value).slice(1, -1));
  }
}

export function redact(text) {
  let result = String(text);
  for (const secret of secrets) result = result.split(secret).join("[redacted]");
  return result;
}

export function out(text) {
  process.stdout.write(redact(text) + "\n");
}

export function err(text) {
  process.stderr.write(redact(text) + "\n");
}
