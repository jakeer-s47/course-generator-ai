// Mock lecture transcript — thermodynamics, Lecture 4.
// Each line already roughly corresponds to a speech chunk.
// "junk" flagged segments are filler / off-topic / admin chatter.

export type TranscriptSegment = {
  text: string;
  junk?: boolean; // if true, gets stripped during Clean
  time: number;   // seconds from start
};

export const mockTranscriptSegments: TranscriptSegment[] = [
  { time: 0,    text: "Okay — uh, can everyone hear me at the back? Yeah? Good." , junk: true },
  { time: 6,    text: "Alright, let's begin Lecture 4." },
  { time: 9,    text: "Today we're going to pick up where we left off on the first law of thermodynamics" },
  { time: 16,   text: "and start building toward the second law, which is where things actually get interesting." },
  { time: 24,   text: "Uh, before we dive in — quick note: the midterm has been moved to next Friday, not this Friday.", junk: true },
  { time: 34,   text: "Check your email for the updated schedule. Any questions on that?", junk: true },
  { time: 40,   text: "No? Good. Moving on." , junk: true },
  { time: 44,   text: "So recall from last time: we defined internal energy U as a state function" },
  { time: 51,   text: "and we derived the relationship dU = δQ − δW for a closed system." },
  { time: 60,   text: "Where δQ is the heat added to the system and δW is the work done by the system on its surroundings." },
  { time: 70,   text: "Notice I'm using δ, not d — because Q and W are path-dependent, not state functions." },
  { time: 80,   text: "This distinction matters. A lot of textbook problems will trip you up on this." },
  { time: 88,   text: "Uh — hold on, can someone in the back close the door? The hallway is loud.", junk: true },
  { time: 95,   text: "Thanks." , junk: true },
  { time: 97,   text: "Alright. So today, we're going to reformulate U using enthalpy H." },
  { time: 104,  text: "H ≡ U + PV. It's a convenience definition, but it's wildly useful when we work at constant pressure." },
  { time: 114,  text: "At constant pressure, dH = δQ, which is why we talk about heat of reaction as ΔH." },
  { time: 123,  text: "Let me show you a worked example on the board." },
  { time: 128,  text: "Consider one mole of an ideal gas, isobarically expanded from V1 to V2 at pressure P." },
  { time: 138,  text: "The work done by the gas is W = P(V2 − V1)." },
  { time: 146,  text: "And from the first law, Q = ΔU + W." },
  { time: 151,  text: "For an ideal gas, ΔU = n Cv ΔT — that's the only thing that matters." },
  { time: 160,  text: "Since we're at constant pressure, ΔT is fixed by PV = nRT, so we can back out Q directly." },
  { time: 170,  text: "Q = n Cp ΔT, where Cp = Cv + R. That's Mayer's relation. Write that down." },
  { time: 180,  text: "Okay — uh, quick tangent: does anyone know what year Mayer published this?", junk: true },
  { time: 188,  text: "1842. Same year as the first photograph of a person. Random but true.", junk: true },
  { time: 196,  text: "Anyway." , junk: true },
  { time: 198,  text: "The key insight is that Cp > Cv always, because at constant pressure, some of the heat goes into work against the surroundings." },
  { time: 210,  text: "At constant volume, no work is done, so all heat goes into raising temperature." },
  { time: 220,  text: "Let me derive Mayer's relation properly, because this always comes up on exams." },
  { time: 228,  text: "Start with dU = n Cv dT for an ideal gas." },
  { time: 235,  text: "Now consider the same gas at constant pressure. dH = dU + d(PV) = dU + nR dT, because PV = nRT." },
  { time: 248,  text: "So dH = n Cv dT + nR dT = n (Cv + R) dT." },
  { time: 258,  text: "But we also know dH = n Cp dT at constant pressure. Therefore Cp = Cv + R. Done." },
  { time: 270,  text: "Any questions?" , junk: true },
  { time: 273,  text: "Good. Now onto the second law — this is the part that bends most people's brains." },
  { time: 281,  text: "The second law introduces entropy, S, which is a state function but, unlike U, it's not conserved." },
  { time: 292,  text: "For any real process, the total entropy of the universe — system plus surroundings — must increase." },
  { time: 303,  text: "Clausius's classic formulation: dS ≥ δQ/T, with equality for reversible processes." },
  { time: 313,  text: "Let me unpack that. Entropy change of the universe is ΔS_universe = ΔS_sys + ΔS_surr." },
  { time: 324,  text: "For a reversible process, ΔS_universe = 0." },
  { time: 331,  text: "For an irreversible process — which is every real process — ΔS_universe > 0." },
  { time: 341,  text: "This single statement rules out perpetual motion machines, and it's why heat engines have efficiency limits." },
  { time: 353,  text: "Next time, we'll derive the Carnot efficiency from entropy arguments alone, which is a beautiful result." },
  { time: 363,  text: "For homework, please do exercises 4.2, 4.7, and 4.11. And, uh, yeah — that's it for today.", junk: true },
];

export function fullTranscriptText(): string {
  return mockTranscriptSegments.map((s) => s.text).join(" ");
}

export function cleanedText(level: "light" | "standard" | "aggressive"): string {
  return mockTranscriptSegments
    .filter((s) => {
      if (!s.junk) return true;
      if (level === "light") return Math.random() > 0.6;
      if (level === "standard") return false;
      return false;
    })
    .map((s) => s.text)
    .join(" ");
}

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
