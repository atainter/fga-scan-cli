/**
 * Pull JSON candidates out of agent output. Agents emit progress text and
 * code snippets before their final answer, so the LAST fenced block is the
 * best candidate, followed by a bare object containing the expected key.
 */
export function extractJsonCandidates(text: string, requiredKey: string): string[] {
  const candidates: string[] = [];

  const fencedBlocks = [...text.matchAll(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/g)];
  if (fencedBlocks.length > 0) {
    candidates.push(fencedBlocks[fencedBlocks.length - 1][1]);
  }

  const bareMatch = text.match(new RegExp(`\\{[\\s\\S]*"${requiredKey}"[\\s\\S]*\\}`));
  if (bareMatch) {
    candidates.push(bareMatch[0]);
  }

  return candidates;
}

/** Parse the first candidate that is a JSON object; null when none parse */
export function parseFirstJsonObject(candidates: string[]): Record<string, unknown> | null {
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}
