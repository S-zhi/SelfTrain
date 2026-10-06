import { z } from 'zod';
import { optionLetters } from './choice';

export { optionLetters, isOptionLetter } from './choice';
export type { OptionLetter } from './choice';

const text = (max: number) => z.string().trim().min(1).max(max);

export const questionSchema = z.object({
  id: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/, '使用稳定的字母、数字、点、下划线、冒号或连字符 ID'),
  language: text(80),
  topic: text(120),
  stem: text(12000),
  options: z.object({
    A: text(4000),
    B: text(4000),
    C: text(4000),
    D: text(4000),
  }).strict().refine(
    (options) => new Set(Object.values(options)).size === 4,
    { message: '四个选项的内容不能重复' },
  ),
  answer: z.enum(optionLetters),
  explanation: text(12000),
  duration_seconds: z.number().int().min(1).max(3600),
  tags: z.array(text(50)).max(12).optional(),
  go_version: text(40).optional(),
}).strict();

export type QuestionInput = z.infer<typeof questionSchema>;
