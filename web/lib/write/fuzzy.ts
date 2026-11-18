/** Match letters in order, including across word boundaries. Keep the caller's trust ordering. */
export function fuzzy(query: string, ...fields: (string | undefined)[]) {
  const normalize = (s: string) =>
    s
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLocaleLowerCase()
      .replace(/\s+/g, "");
  const term = normalize(query);
  return (
    !term ||
    fields.some((field) => {
      const input = normalize(field || "");
      let pos = -1;
      for (const ch of term) {
        pos = input.indexOf(ch, pos + 1);
        if (pos < 0) return false;
      }
      return true;
    })
  );
}
