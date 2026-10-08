const BEGIN = "<!-- alliance-work:instructions -->";
const END = "<!-- /alliance-work:instructions -->";

// Native scheduled agents may inherit their parent's systemPrompt. Replace only our
// leading generated block, retaining any caller-supplied instructions after it.
export function composeInstruction(roleInstruction: string, inherited = "") {
  let remaining = inherited;
  if (remaining.startsWith(BEGIN)) {
    const boundary = remaining.indexOf(END);
    if (boundary < 0) throw new Error("Incomplete Alliance instruction block");
    remaining = remaining.slice(boundary + END.length).trimStart();
  }
  return `${BEGIN}\n${roleInstruction}\n${END}\n\n${remaining}`;
}
