const MIN_LENGTH = 3;

export function detectLeakage(text: string, knownOriginals: string[]): string[] {
  const leaked: string[] = [];
  for (const original of knownOriginals) {
    if (original.length < MIN_LENGTH) continue;
    if (text.includes(original)) {
      leaked.push(original);
    }
  }
  return leaked;
}
