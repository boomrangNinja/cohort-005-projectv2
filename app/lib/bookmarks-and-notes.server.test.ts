import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { UserRole } from "~/db/schema";
import { isBookmarked, listBookmarks, toggleBookmark } from "./bookmarks.server";
import { MAX_NOTE_LENGTH, getNote, listNotes, saveNote } from "./notes.server";
import { approveRefundRequest, raiseRefundRequest } from "./refunds.server";
import { fakeNotifications } from "./notifications.fake.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);

function minutesAfter(minutes: number) {
  return new Date(NOW.getTime() + minutes * 60_000);
}

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let lessonIds: number[];
let otherStudentId: number;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);

  const module = db
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Basics", position: 1 })
    .returning()
    .get();

  lessonIds = [1, 2, 3].map(
    (position) =>
      db
        .insert(schema.lessons)
        .values({ moduleId: module.id, title: `Lesson ${position}`, position })
        .returning()
        .get().id
  );

  otherStudentId = db
    .insert(schema.users)
    .values({ name: "Other", email: "other@example.com", role: UserRole.Student })
    .returning()
    .get().id;
});

describe("bookmarking a Lesson", () => {
  it("adds a Bookmark, then removes it on the next toggle", () => {
    expect(toggleBookmark(db, base.user.id, lessonIds[0], NOW)).toBe(true);
    expect(isBookmarked(db, base.user.id, lessonIds[0])).toBe(true);

    expect(toggleBookmark(db, base.user.id, lessonIds[0], NOW)).toBe(false);
    expect(isBookmarked(db, base.user.id, lessonIds[0])).toBe(false);
  });

  it("never leaves a Student with two Bookmarks on one Lesson", () => {
    toggleBookmark(db, base.user.id, lessonIds[0], NOW);

    expect(() =>
      db
        .insert(schema.bookmarks)
        .values({ userId: base.user.id, lessonId: lessonIds[0] })
        .run()
    ).toThrow();
    expect(listBookmarks(db, base.user.id)).toHaveLength(1);
  });
});

describe("saving a Note", () => {
  it("creates the Note, trimmed, when the Lesson has none", () => {
    const result = saveNote(db, base.user.id, lessonIds[0], "  First go  ", NOW);

    expect(result).toMatchObject({
      ok: true,
      note: {
        body: "First go",
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      },
    });
  });

  it("replaces the body and moves the last-edited time on when saved again", () => {
    saveNote(db, base.user.id, lessonIds[0], "First go", NOW);
    saveNote(db, base.user.id, lessonIds[0], "Second go", minutesAfter(5));

    expect(getNote(db, base.user.id, lessonIds[0])).toMatchObject({
      body: "Second go",
      createdAt: NOW.toISOString(),
      updatedAt: minutesAfter(5).toISOString(),
    });
    expect(listNotes(db, base.user.id)).toHaveLength(1);
  });

  it("never leaves a Student with two Notes on one Lesson", () => {
    saveNote(db, base.user.id, lessonIds[0], "Mine", NOW);

    expect(() =>
      db
        .insert(schema.notes)
        .values({ userId: base.user.id, lessonId: lessonIds[0], body: "Dupe" })
        .run()
    ).toThrow();
  });

  it(`accepts exactly ${MAX_NOTE_LENGTH} characters`, () => {
    const body = "a".repeat(MAX_NOTE_LENGTH);
    expect(saveNote(db, base.user.id, lessonIds[0], body, NOW)).toMatchObject({
      ok: true,
      note: { body },
    });
  });

  it(`refuses ${MAX_NOTE_LENGTH + 1} characters with a message`, () => {
    const body = "a".repeat(MAX_NOTE_LENGTH + 1);
    expect(saveNote(db, base.user.id, lessonIds[0], body, NOW)).toEqual({
      ok: false,
      error: "A note must be 2,000 characters or fewer.",
    });
    expect(getNote(db, base.user.id, lessonIds[0])).toBeUndefined();
  });

  it("keeps the text exactly as typed, Markdown characters included", () => {
    saveNote(db, base.user.id, lessonIds[0], "# not a heading\n*not bold*", NOW);
    expect(getNote(db, base.user.id, lessonIds[0])?.body).toBe(
      "# not a heading\n*not bold*"
    );
  });
});

describe("the Saved lists", () => {
  it("hold only the Student's own Bookmarks, newest first, with Lesson and Course", () => {
    toggleBookmark(db, base.user.id, lessonIds[0], NOW);
    toggleBookmark(db, base.user.id, lessonIds[1], minutesAfter(1));
    toggleBookmark(db, otherStudentId, lessonIds[2], minutesAfter(2));

    expect(listBookmarks(db, base.user.id)).toEqual([
      expect.objectContaining({
        lessonId: lessonIds[1],
        lessonTitle: "Lesson 2",
        courseTitle: "Test Course",
        courseSlug: "test-course",
      }),
      expect.objectContaining({ lessonId: lessonIds[0], lessonTitle: "Lesson 1" }),
    ]);
  });

  it("hold only the Student's own Notes, last edited first, with Lesson and Course", () => {
    saveNote(db, base.user.id, lessonIds[0], "Older", NOW);
    saveNote(db, base.user.id, lessonIds[1], "Newer", minutesAfter(1));
    saveNote(db, otherStudentId, lessonIds[2], "Not mine", minutesAfter(2));
    saveNote(db, base.user.id, lessonIds[0], "Older, edited", minutesAfter(3));

    expect(listNotes(db, base.user.id)).toEqual([
      expect.objectContaining({
        lessonId: lessonIds[0],
        body: "Older, edited",
        courseTitle: "Test Course",
        courseSlug: "test-course",
      }),
      expect.objectContaining({ lessonId: lessonIds[1], body: "Newer" }),
    ]);
  });
});

describe("approving a Refund", () => {
  it("keeps the Student's Bookmarks and Notes", async () => {
    const purchase = db
      .insert(schema.purchases)
      .values({ userId: base.user.id, courseId: base.course.id, amountPaid: 7900 })
      .returning()
      .get();
    db.insert(schema.enrollments)
      .values({ userId: base.user.id, courseId: base.course.id })
      .run();
    toggleBookmark(db, base.user.id, lessonIds[0], NOW);
    saveNote(db, base.user.id, lessonIds[0], "Still mine", NOW);

    const notifications = fakeNotifications();
    const raised = await raiseRefundRequest(
      db,
      purchase.id,
      base.user.id,
      "Not for me.",
      new Date(),
      notifications
    );
    if (!raised.ok) throw new Error(raised.error);
    const admin = db
      .insert(schema.users)
      .values({ name: "Admin", email: "admin@example.com", role: UserRole.Admin })
      .returning()
      .get();
    const approved = await approveRefundRequest(
      db,
      raised.refundRequestId,
      admin.id,
      null,
      new Date(),
      notifications
    );
    expect(approved.ok).toBe(true);

    expect(isBookmarked(db, base.user.id, lessonIds[0])).toBe(true);
    expect(getNote(db, base.user.id, lessonIds[0])?.body).toBe("Still mine");
  });
});
