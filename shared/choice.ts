export const optionLetters = ['A', 'B', 'C', 'D'] as const;
export type OptionLetter = (typeof optionLetters)[number];

export function isOptionLetter(value: unknown): value is OptionLetter {
  return typeof value === 'string' && optionLetters.includes(value as OptionLetter);
}
