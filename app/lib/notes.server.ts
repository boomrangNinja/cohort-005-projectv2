import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { courses, lessons, modules, notes } from "~/db/schema";
import type { Db } from "~/lib/comments.server";

// ─── Notes ───
// A Student's own writing about a Lesson, private to the Student who wrote
// it. See GLOSSARY.md. One per Student per Lesson: the unique index on
// (user_id, lesson_id) holds that, not this module.
//
// Only the owning Student's Lesson page and Saved page may read Note bodies.
// No Instructor or Platform Admin view reads them.
//
// Every function takes the database first, so tests can hand in an in-memory
// one.

export const MAX_NOTE_LENGTH = 2000;

const NOTE_TOO_LONG = `A note must be ${MAX_NOTE_LENGTH.toLocaleString("en-US")} characters or fewer.`;
const NOTE_EMPTY = "Write something before saving your note.";

/** Plain text, trimmed, capped. Never rendered as Markdown. */
export const noteBodySchema = z
  .string()
  .trim()
  .min(1, NOTE_EMPTY)
  .max(MAX_NOTE_LENGTH, NOTE_TOO_LONG);

export type Note = typeof notes.$inferSelect;

export type SaveNoteResult =
  { ok: true; note: Note } | { ok: false; error: string };

export function getNote(db: Db, userId: number, lessonId: number) {
  return db
    .select()
    .from(notes)
    .where(and(eq(notes.userId, userId), eq(notes.lessonId, lessonId)))
    .get();
}

/**
 * Creates the Student's Note on a Lesson, or replaces the body of the one they
 * already have and moves its "last edited" time (`updatedAt`) on. `createdAt`
 * never changes on a re-save.
 */
export function saveNote(
  db: Db,
  userId: number,
  lessonId: number,
  body: string,
  now: Date
): SaveNoteResult {
  const parsed = noteBodySchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? NOTE_TOO_LONG };
  }

  const at = now.toISOString();
  const note = db
    .insert(notes)
    .values({ userId, lessonId, body: parsed.data, createdAt: at, updatedAt: at })
    .onConflictDoUpdate({
      target: [notes.userId, notes.lessonId],
      set: { body: parsed.data, updatedAt: at },
    })
    .returning()
    .get();

  return { ok: true, note };
}

/** The Student's Notes, last edited first, each with its Lesson and Course. */
export function listNotes(db: Db, userId: number) {
  return db
    .select({
      id: notes.id,
      body: notes.body,
      updatedAt: notes.updatedAt,
      lessonId: lessons.id,
      lessonTitle: lessons.title,
      courseTitle: courses.title,
      courseSlug: courses.slug,
    })
    .from(notes)
    .innerJoin(lessons, eq(lessons.id, notes.lessonId))
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .innerJoin(courses, eq(courses.id, modules.courseId))
    .where(eq(notes.userId, userId))
    .orderBy(desc(notes.updatedAt), desc(notes.id))
    .all();
}
