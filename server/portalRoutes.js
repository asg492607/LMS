import { Router } from 'express';
import { FieldValue, Timestamp, adminDb, UNIVERSITY_ID } from './supabaseDb.js';

const router = Router();
const MAX_SCOPE_RECORDS = 500;
const MAX_SCOPE_PEOPLE = 300;
const MAX_CONTENT_ITEMS = 500;
const MAX_QUIZ_QUESTIONS = 30;

const supportedRoles = new Set([
  'school_admin', 'dean', 'hod', 'subject_coordinator',
  'subject_teacher', 'class_teacher', 'student',
]);

function serialize(snapshot) {
  const data = snapshot.data() || {};
  return { id: snapshot.id, ...data };
}

async function getRecord(collection, id) {
  if (!id) return null;
  const snapshot = await adminDb.collection(collection).doc(id).get();
  if (!snapshot.exists || snapshot.data()?.universityId !== UNIVERSITY_ID) return null;
  return serialize(snapshot);
}

async function getRecords(collection, field, value) {
  if (!value) return [];
  const snapshot = await adminDb.collection(collection)
    .where(field, '==', value)
    .limit(MAX_SCOPE_RECORDS)
    .get();
  return snapshot.docs
    .map(serialize)
    .filter((item) => item.universityId === UNIVERSITY_ID);
}

async function getRelatedRoleDocs(field, value, limit = MAX_SCOPE_PEOPLE) {
  if (!value) return [];
  const snapshot = await adminDb.collectionGroup('roles')
    .where(field, '==', value)
    .limit(limit)
    .get();
  return snapshot.docs.filter((doc) => doc.data()?.universityId === UNIVERSITY_ID);
}

async function getPeople(roleDocs, { includeEmails = false, visibleRoles = null } = {}) {
  const selected = visibleRoles
    ? roleDocs.filter((doc) => visibleRoles.has(doc.data()?.role))
    : roleDocs;
  const userRefs = [...new Map(selected.map((doc) => {
    const userRef = doc.ref.parent.parent;
    return userRef ? [userRef.id, userRef] : null;
  }).filter(Boolean)).values()];
  const userSnapshots = userRefs.length ? await adminDb.getAll(...userRefs) : [];
  const profiles = new Map(userSnapshots.map((snapshot) => [snapshot.id, snapshot.data() || {}]));
  return selected.map((doc) => {
    const data = doc.data() || {};
    const uid = doc.ref.parent.parent?.id;
    const profile = profiles.get(uid) || {};
    return {
      uid,
      role: data.role,
      roleLabel: data.roleLabel || data.role,
      scopeId: data.scopeId || '',
      scopeName: data.scopeName || '',
      subjectId: data.subjectId || '',
      offeringId: data.offeringId || '',
      displayName: profile.displayName || 'LMS member',
      ...(includeEmails && data.role !== 'student' && profile.email ? { email: profile.email } : {}),
    };
  });
}

async function listRolesForUser(uid) {
  const snapshot = await adminDb.collection('users').doc(uid).collection('roles').limit(100).get();
  return snapshot.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((role) => role.universityId === UNIVERSITY_ID && supportedRoles.has(role.role));
}

function dateToIso(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function serializeLearningItem(snapshot, { includeAnswerKey = false } = {}) {
  const item = serialize(snapshot);
  item.createdAt = dateToIso(item.createdAt);
  item.updatedAt = dateToIso(item.updatedAt);
  item.publishedAt = dateToIso(item.publishedAt);
  item.dueAt = dateToIso(item.dueAt);
  item.questions = Array.isArray(item.questions)
    ? item.questions.map(({ id, prompt, choices, points, answerIndex }) => ({
      id, prompt, choices, points, ...(includeAnswerKey ? { answerIndex } : {}),
    }))
    : [];
  return item;
}

function serializeSubmission(snapshot) {
  const submission = serialize(snapshot);
  submission.submittedAt = dateToIso(submission.submittedAt);
  submission.gradedAt = dateToIso(submission.gradedAt);
  return submission;
}

function cleanText(value, maxLength = 3000) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, maxLength) : '';
}

function indiaDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function validateItemInput(input) {
  const itemType = cleanText(input?.itemType, 30).toLowerCase();
  const title = cleanText(input?.title, 120);
  const description = typeof input?.description === 'string' ? input.description.trim().slice(0, 5000) : '';
  const status = input?.status === 'draft' ? 'draft' : 'published';
  if (!['quiz', 'assignment', 'resource', 'announcement'].includes(itemType)) {
    throw Object.assign(new Error('Choose a quiz, assignment, resource, or announcement.'), { statusCode: 400 });
  }
  if (title.length < 3) throw Object.assign(new Error('Enter a title with at least 3 characters.'), { statusCode: 400 });
  if (description.length < 3) throw Object.assign(new Error('Add instructions or a short description.'), { statusCode: 400 });

  let dueAt = null;
  if (input?.dueAt) {
    const parsedDueAt = new Date(input.dueAt);
    if (Number.isNaN(parsedDueAt.getTime())) throw Object.assign(new Error('Enter a valid due date.'), { statusCode: 400 });
    dueAt = Timestamp.fromDate(parsedDueAt);
  }

  const item = { itemType, title, description, status, dueAt };
  if (itemType === 'quiz') {
    if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > MAX_QUIZ_QUESTIONS) {
      throw Object.assign(new Error(`A quiz must contain 1–${MAX_QUIZ_QUESTIONS} questions.`), { statusCode: 400 });
    }
    item.questions = input.questions.map((question, index) => {
      const prompt = cleanText(question?.prompt, 500);
      const choices = Array.isArray(question?.choices)
        ? question.choices.map((choice) => cleanText(choice, 240)).filter(Boolean)
        : [];
      const answerIndex = Number(question?.answerIndex);
      const points = Number(question?.points ?? 1);
      if (prompt.length < 5 || choices.length < 2 || choices.length > 6 || !Number.isInteger(answerIndex)
          || answerIndex < 0 || answerIndex >= choices.length || !Number.isInteger(points) || points < 1 || points > 100) {
        throw Object.assign(new Error(`Question ${index + 1} needs a prompt, at least two choices, a correct answer, and 1–100 points.`), { statusCode: 400 });
      }
      return { id: `q${index + 1}`, prompt, choices, answerIndex, points };
    });
    item.maxPoints = item.questions.reduce((total, question) => total + question.points, 0);
    if (item.maxPoints > 1000) throw Object.assign(new Error('A quiz can total at most 1000 points.'), { statusCode: 400 });
  } else if (itemType === 'assignment') {
    item.questions = [];
    item.maxPoints = Number(input?.maxPoints ?? 100);
    if (!Number.isInteger(item.maxPoints) || item.maxPoints < 1 || item.maxPoints > 1000) {
      throw Object.assign(new Error('Points must be a whole number from 1 to 1000.'), { statusCode: 400 });
    }
  } else {
    item.questions = [];
  }
  if (itemType === 'resource') {
    const resourceUrl = cleanText(input?.resourceUrl, 1000);
    let parsedUrl;
    try { parsedUrl = new URL(resourceUrl); } catch { parsedUrl = null; }
    if (!parsedUrl || parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password) {
      throw Object.assign(new Error('Resources must use a valid HTTPS link.'), { statusCode: 400 });
    }
    item.resourceUrl = parsedUrl.toString();
  }
  return item;
}

function canManageOffering(role, offering, itemType = '') {
  if (!role || !offering) return false;
  if (role.role === 'subject_teacher' && role.scopeId === offering.id) return true;
  if (role.role === 'subject_coordinator' && role.subjectId === offering.subjectId) return true;
  if (role.role === 'class_teacher' && (role.divisionId || role.scopeId) === offering.divisionId && ['announcement', 'attendance'].includes(itemType)) return true;
  if (role.role === 'hod' && role.scopeId === offering.departmentId && itemType === 'announcement') return true;
  if (['school_admin', 'dean'].includes(role.role) && role.schoolId === offering.schoolId && itemType === 'announcement') return true;
  return false;
}

async function hasManagementAccess(uid, offering, itemType = '') {
  const roles = await listRolesForUser(uid);
  return roles.some((role) => canManageOffering(role, offering, itemType));
}

async function getContentForScope(role, dashboard) {
  let snapshots = [];
  if (role.role === 'student' || role.role === 'class_teacher') {
    const divisionId = role.role === 'student' ? role.scopeId : dashboard.context.division?.id || role.divisionId;
    if (divisionId) snapshots = (await adminDb.collection('learningItems').where('divisionId', '==', divisionId).limit(MAX_CONTENT_ITEMS).get()).docs;
  } else if (role.role === 'school_admin' || role.role === 'dean') {
    snapshots = (await adminDb.collection('learningItems').where('schoolId', '==', role.scopeId).limit(MAX_CONTENT_ITEMS).get()).docs;
  } else if (role.role === 'hod') {
    snapshots = (await adminDb.collection('learningItems').where('departmentId', '==', role.scopeId).limit(MAX_CONTENT_ITEMS).get()).docs;
  } else {
    const offeringIds = role.role === 'subject_teacher'
      ? [role.scopeId]
      : dashboard.offerings.map((offering) => offering.id);
    const results = await Promise.all(offeringIds.slice(0, 50).map((offeringId) =>
      adminDb.collection('learningItems').where('offeringId', '==', offeringId).limit(100).get()));
    snapshots = results.flatMap((result) => result.docs).slice(0, MAX_CONTENT_ITEMS);
  }
  return snapshots
    .filter((snapshot) => snapshot.data()?.universityId === UNIVERSITY_ID)
    .map((snapshot) => serializeLearningItem(snapshot, {
      includeAnswerKey: ['subject_teacher', 'subject_coordinator'].includes(role.role),
    }))
    .filter((item) => role.role !== 'student' || item.status === 'published')
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

async function getSubmissionsForScope(role, dashboard, uid) {
  let snapshots = [];
  if (role.role === 'student') {
    snapshots = (await adminDb.collection('learningSubmissions').where('studentUid', '==', uid).limit(MAX_CONTENT_ITEMS).get()).docs;
  } else if (['subject_teacher', 'subject_coordinator', 'school_admin', 'dean', 'hod'].includes(role.role)) {
    const offeringIds = role.role === 'subject_teacher'
      ? [role.scopeId]
      : dashboard.offerings.map((offering) => offering.id);
    const results = await Promise.all(offeringIds.slice(0, 50).map((offeringId) =>
      adminDb.collection('learningSubmissions').where('offeringId', '==', offeringId).limit(100).get()));
    snapshots = results.flatMap((result) => result.docs).slice(0, MAX_CONTENT_ITEMS);
  }
  return snapshots
    .filter((snapshot) => snapshot.data()?.universityId === UNIVERSITY_ID
      && (role.role !== 'student' || snapshot.data()?.divisionId === role.scopeId))
    .map(serializeSubmission)
    .sort((a, b) => String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')));
}

function serializeAttendance(snapshot, studentUid = '') {
  const data = serialize(snapshot);
  data.createdAt = dateToIso(data.createdAt);
  data.updatedAt = dateToIso(data.updatedAt);
  if (studentUid) {
    data.records = (data.records || []).filter((record) => record.uid === studentUid);
    delete data.recordedBy;
    delete data.updatedBy;
  }
  return data;
}

async function validateAttendanceRecords(offering, inputRecords) {
  if (!Array.isArray(inputRecords) || inputRecords.length < 1 || inputRecords.length > MAX_SCOPE_PEOPLE) {
    throw Object.assign(new Error(`Attendance must include 1–${MAX_SCOPE_PEOPLE} students.`), { statusCode: 400 });
  }
  const studentRoleDocs = await getRelatedRoleDocs('divisionId', offering.divisionId, MAX_SCOPE_PEOPLE + 1);
  const roster = await getPeople(studentRoleDocs, { visibleRoles: new Set(['student']) });
  if (roster.length > MAX_SCOPE_PEOPLE) {
    throw Object.assign(new Error(`This attendance register supports up to ${MAX_SCOPE_PEOPLE} students at a time.`), { statusCode: 413 });
  }
  if (!roster.length) throw Object.assign(new Error('No students are enrolled in this division yet.'), { statusCode: 409 });
  const rosterByUid = new Map(roster.map((student) => [student.uid, student]));
  const seen = new Set();
  const allowedStatuses = new Set(['present', 'absent', 'late', 'excused']);
  const records = [];
  for (const record of inputRecords) {
    const uid = cleanText(record?.uid, 180);
    const status = cleanText(record?.status, 20).toLowerCase();
    const student = rosterByUid.get(uid);
    if (!student || seen.has(uid) || !allowedStatuses.has(status)) {
      throw Object.assign(new Error('Attendance contains an invalid student or status. Refresh the roster and try again.'), { statusCode: 400 });
    }
    seen.add(uid);
    records.push({ uid, displayName: student.displayName, status });
  }
  if (seen.size !== rosterByUid.size) {
    throw Object.assign(new Error('Record a status for every student in this division.'), { statusCode: 400 });
  }
  return records;
}

async function getAttendanceForScope(role, dashboard, uid) {
  let snapshots = [];
  if (role.role === 'student') {
    snapshots = (await adminDb.collection('attendanceSessions').where('divisionId', '==', role.scopeId).limit(200).get()).docs;
  } else if (role.role === 'school_admin' || role.role === 'dean') {
    snapshots = (await adminDb.collection('attendanceSessions').where('schoolId', '==', role.scopeId).limit(200).get()).docs;
  } else if (role.role === 'hod') {
    snapshots = (await adminDb.collection('attendanceSessions').where('departmentId', '==', role.scopeId).limit(200).get()).docs;
  } else if (role.role === 'class_teacher') {
    const divisionId = role.divisionId || role.scopeId;
    snapshots = (await adminDb.collection('attendanceSessions').where('divisionId', '==', divisionId).limit(200).get()).docs;
  } else if (role.role === 'subject_teacher' || role.role === 'subject_coordinator') {
    const offeringIds = role.role === 'subject_teacher' ? [role.scopeId] : dashboard.offerings.map((offering) => offering.id);
    const results = await Promise.all(offeringIds.slice(0, 50).map((offeringId) =>
      adminDb.collection('attendanceSessions').where('offeringId', '==', offeringId).limit(100).get()));
    snapshots = results.flatMap((result) => result.docs).slice(0, MAX_CONTENT_ITEMS);
  }
  return snapshots
    .filter((snapshot) => snapshot.data()?.universityId === UNIVERSITY_ID)
    .map((snapshot) => serializeAttendance(snapshot, role.role === 'student' ? uid : ''))
    .sort((a, b) => String(b.sessionDate || '').localeCompare(String(a.sessionDate || '')) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

export function calculateAcademicMetrics(subjects, offerings, people, items, submissions, attendance) {
  const students = [...new Map(people
    .filter((person) => person.role === 'student')
    .map((person) => [person.uid, person])).values()];
  const studentsByDivision = new Map();
  students.forEach((student) => {
    const divisionId = student.divisionId || student.scopeId;
    if (!divisionId) return;
    studentsByDivision.set(divisionId, [...(studentsByDivision.get(divisionId) || []), student]);
  });

  const assessmentItems = items.filter((item) =>
    item.status === 'published' && ['quiz', 'assignment'].includes(item.itemType));
  const overdueAssessmentItems = assessmentItems.filter((item) => {
    const dueAt = item.dueAt ? new Date(item.dueAt).getTime() : NaN;
    return Number.isFinite(dueAt) && dueAt < Date.now();
  });
  const itemById = new Map(assessmentItems.map((item) => [item.id, item]));
  const uniqueSubmissions = new Map();
  submissions.forEach((submission) => {
    const item = itemById.get(submission.itemId);
    if (!item || !submission.studentUid) return;
    const offering = offerings.find((entry) => entry.id === item.offeringId);
    if (!offering || !studentsByDivision.get(offering.divisionId)?.some((student) => student.uid === submission.studentUid)) return;
    uniqueSubmissions.set(`${item.id}:${submission.studentUid}`, submission);
  });

  const sessionRecords = attendance.flatMap((session) => {
    const offering = offerings.find((entry) => entry.id === session.offeringId);
    return offering ? (session.records || []).map((record) => ({ ...record, offeringId: offering.id, divisionId: offering.divisionId })) : [];
  }).filter((record) => studentsByDivision.get(record.divisionId)?.some((student) => student.uid === record.uid));

  const summarize = (scopeSubjects, divisionId = '') => {
    const subjectIds = new Set(scopeSubjects.map((subject) => subject.id));
    const scopeOfferings = offerings.filter((offering) => subjectIds.has(offering.subjectId)
      && (!divisionId || offering.divisionId === divisionId));
    const offeringIds = new Set(scopeOfferings.map((offering) => offering.id));
    const scopeItems = assessmentItems.filter((item) => offeringIds.has(item.offeringId));
    const scopeItemIds = new Set(scopeItems.map((item) => item.id));
    const scopeSubmissions = [...uniqueSubmissions.values()].filter((submission) => scopeItemIds.has(submission.itemId));
    const expectedSubmissions = scopeItems.reduce((total, item) => {
      const offering = scopeOfferings.find((entry) => entry.id === item.offeringId);
      return total + (offering ? (studentsByDivision.get(offering.divisionId)?.length || 0) : 0);
    }, 0);
    const actualSubmissions = scopeSubmissions.length;
    const scoreRows = scopeSubmissions.filter((submission) => submission.score != null
      && Number(submission.maxPoints) > 0 && Number.isFinite(Number(submission.score)));
    const scorePercentages = scoreRows.map((submission) => (Number(submission.score) / Number(submission.maxPoints)) * 100);
    const averageScore = scorePercentages.length
      ? Math.round(scorePercentages.reduce((sum, score) => sum + score, 0) / scorePercentages.length)
      : null;
    const scoreBands = {
      below40: scorePercentages.filter((score) => score < 40).length,
      from40to59: scorePercentages.filter((score) => score >= 40 && score < 60).length,
      from60to79: scorePercentages.filter((score) => score >= 60 && score < 80).length,
      atLeast80: scorePercentages.filter((score) => score >= 80).length,
    };
    const divisionIds = new Set(scopeOfferings.map((offering) => offering.divisionId));
    const enrolled = [...new Map([...divisionIds].flatMap((divisionId) => studentsByDivision.get(divisionId) || []).map((student) => [student.uid, student])).values()];
    const scopeAttendance = sessionRecords.filter((record) => offeringIds.has(record.offeringId));
    const eligibleAttendance = scopeAttendance.filter((record) => record.status !== 'excused');
    const attended = eligibleAttendance.filter((record) => ['present', 'late'].includes(record.status)).length;
    const attendanceRate = eligibleAttendance.length ? Math.round((attended / eligibleAttendance.length) * 100) : null;

    const atRisk = enrolled.filter((student) => {
      const divisionId = student.divisionId || student.scopeId;
      const studentItems = overdueAssessmentItems.filter((item) => offeringIds.has(item.offeringId)
        && scopeOfferings.some((offering) => offering.id === item.offeringId && offering.divisionId === divisionId));
      const studentSubmissionCount = studentItems.filter((item) => uniqueSubmissions.has(`${item.id}:${student.uid}`)).length;
      const studentCompletion = studentItems.length ? studentSubmissionCount / studentItems.length : null;
      const studentAttendance = scopeAttendance.filter((record) => record.uid === student.uid && record.status !== 'excused');
      const studentAttended = studentAttendance.filter((record) => ['present', 'late'].includes(record.status)).length;
      const studentAttendanceRate = studentAttendance.length ? studentAttended / studentAttendance.length : null;
      return (studentCompletion !== null && studentItems.length >= 2 && studentCompletion < 0.5)
        || (studentAttendanceRate !== null && studentAttendance.length >= 2 && studentAttendanceRate < 0.75);
    }).length;

    return {
      students: enrolled.length,
      subjects: scopeSubjects.length,
      teachingGroups: scopeOfferings.length,
      publishedAssessments: scopeItems.length,
      submissions: actualSubmissions,
      assessmentCompletionRate: expectedSubmissions ? Math.min(100, Math.round((actualSubmissions / expectedSubmissions) * 100)) : null,
      averageScore,
      scoreBands,
      attendanceRate,
      atRiskStudents: atRisk,
    };
  };

  const subjectRows = subjects.map((subject) => ({
    id: subject.id,
    name: subject.name,
    code: subject.code,
    semesterId: subject.semesterId || '',
    semesterName: subject.semesterName || '',
    ...summarize([subject]),
  })).sort((a, b) => a.name.localeCompare(b.name));
  const semesterMap = new Map();
  subjects.forEach((subject) => {
    const id = subject.semesterId || 'unassigned';
    const current = semesterMap.get(id) || { id, name: subject.semesterName || 'Unassigned semester', subjects: [] };
    current.subjects.push(subject);
    current.academicYearName ||= subject.academicYearName || '';
    semesterMap.set(id, current);
  });
  const semesters = [...semesterMap.values()].map(({ id, name, academicYearName, subjects: semesterSubjects }) => ({
    id,
    name: academicYearName ? `${academicYearName} · ${name}` : name,
    ...summarize(semesterSubjects),
  })).sort((a, b) => a.name.localeCompare(b.name));

  const divisionsById = new Map();
  offerings.forEach((offering) => {
    if (!divisionsById.has(offering.divisionId)) {
      divisionsById.set(offering.divisionId, {
        id: offering.divisionId,
        name: offering.divisionName || offering.divisionCode || 'Teaching group',
        code: offering.divisionCode || '',
        semesterId: offering.semesterId || '',
        semesterName: offering.academicYearName
          ? `${offering.academicYearName} · ${offering.semesterName || ''}`
          : (offering.semesterName || ''),
      });
    }
  });
  const divisions = [...divisionsById.values()].map((division) => ({
    ...division,
    ...summarize(subjects.filter((subject) => subject.semesterId === division.semesterId), division.id),
  })).sort((a, b) => a.name.localeCompare(b.name));

  return {
    summary: summarize(subjects),
    semesters,
    subjects: subjectRows,
    divisions,
    riskDefinition: 'At risk means under 50% completion across at least two past-due assessments, or attendance below 75% across at least two recorded sessions.',
  };
}

async function buildScope(role) {
  const response = {
    scope: role,
    context: {},
    departments: [],
    programs: [],
    academicYears: [],
    semesters: [],
    divisions: [],
    subjects: [],
    offerings: [],
    people: [],
  };
  const canSeeContacts = ['school_admin', 'dean', 'hod'].includes(role.role);

  if (role.role === 'school_admin' || role.role === 'dean') {
    const school = await getRecord('schools', role.scopeId);
    if (!school) return null;
    response.context.school = school;
    [response.departments, response.programs, response.academicYears, response.semesters,
      response.divisions, response.subjects, response.offerings] = await Promise.all([
      getRecords('departments', 'schoolId', school.id),
      getRecords('programs', 'schoolId', school.id),
      getRecords('academicYears', 'schoolId', school.id),
      getRecords('semesters', 'schoolId', school.id),
      getRecords('divisions', 'schoolId', school.id),
      getRecords('subjects', 'schoolId', school.id),
      getRecords('offerings', 'schoolId', school.id),
    ]);
    response.people = await getPeople(await getRelatedRoleDocs('schoolId', school.id), { includeEmails: canSeeContacts });
  } else if (role.role === 'hod') {
    const department = await getRecord('departments', role.scopeId);
    if (!department) return null;
    response.context.department = department;
    [response.programs, response.academicYears, response.semesters, response.divisions,
      response.subjects, response.offerings] = await Promise.all([
      getRecords('programs', 'departmentId', department.id),
      getRecords('academicYears', 'departmentId', department.id),
      getRecords('semesters', 'departmentId', department.id),
      getRecords('divisions', 'departmentId', department.id),
      getRecords('subjects', 'departmentId', department.id),
      getRecords('offerings', 'departmentId', department.id),
    ]);
    response.people = await getPeople(await getRelatedRoleDocs('departmentId', department.id), { includeEmails: canSeeContacts });
  } else if (role.role === 'subject_coordinator') {
    const subject = await getRecord('subjects', role.scopeId);
    if (!subject) return null;
    response.context.subject = subject;
    response.subjects = [subject];
    response.offerings = await getRecords('offerings', 'subjectId', subject.id);
    const divisionIds = [...new Set(response.offerings.map((offering) => offering.divisionId).filter(Boolean))];
    response.divisions = (await Promise.all(divisionIds.map((id) => getRecord('divisions', id)))).filter(Boolean);
    response.context.semester = await getRecord('semesters', subject.semesterId);
    response.context.program = await getRecord('programs', subject.programId);
    if (response.context.semester) response.semesters = [response.context.semester];
    if (response.context.program) response.programs = [response.context.program];
    const peopleByRole = new Map();
    for (const offering of response.offerings) {
      const [offeringRoles, divisionRoles] = await Promise.all([
        getRelatedRoleDocs('offeringId', offering.id),
        getRelatedRoleDocs('divisionId', offering.divisionId),
      ]);
      const people = await getPeople([...offeringRoles, ...divisionRoles], {
        visibleRoles: new Set(['student', 'class_teacher', 'subject_teacher', 'subject_coordinator']),
      });
      people.forEach((person) => peopleByRole.set(`${person.uid}:${person.role}`, person));
    }
    response.people = [...peopleByRole.values()];
  } else if (role.role === 'subject_teacher') {
    const offering = await getRecord('offerings', role.scopeId);
    if (!offering) return null;
    response.context.offering = offering;
    response.context.subject = await getRecord('subjects', offering.subjectId);
    response.context.division = await getRecord('divisions', offering.divisionId);
    response.context.semester = await getRecord('semesters', offering.semesterId);
    response.context.program = await getRecord('programs', offering.programId);
    response.subjects = response.context.subject ? [response.context.subject] : [];
    response.divisions = response.context.division ? [response.context.division] : [];
    response.semesters = response.context.semester ? [response.context.semester] : [];
    response.offerings = [offering];
    response.people = await getPeople(await getRelatedRoleDocs('divisionId', offering.divisionId), {
      visibleRoles: new Set(['student', 'class_teacher', 'subject_teacher']),
    });
  } else if (role.role === 'class_teacher' || role.role === 'student') {
    const division = await getRecord('divisions', role.scopeId);
    if (!division) return null;
    response.context.division = division;
    response.context.semester = await getRecord('semesters', division.semesterId);
    response.context.program = await getRecord('programs', division.programId);
    response.divisions = [division];
    response.semesters = response.context.semester ? [response.context.semester] : [];
    response.offerings = await getRecords('offerings', 'divisionId', division.id);
    const subjectIds = [...new Set(response.offerings.map((offering) => offering.subjectId).filter(Boolean))];
    response.subjects = (await Promise.all(subjectIds.map((id) => getRecord('subjects', id)))).filter(Boolean);
    const relatedRoles = await getRelatedRoleDocs('divisionId', division.id);
    response.people = await getPeople(relatedRoles, {
      visibleRoles: role.role === 'student'
        ? new Set(['class_teacher', 'subject_teacher'])
        : new Set(['student', 'class_teacher', 'subject_teacher']),
    });
  }

  return response;
}

router.get('/dashboard', async (request, response) => {
  if (!adminDb) return response.status(503).json({ error: 'Supabase Postgres is not configured for the learning portal.' });
  try {
    const roles = await listRolesForUser(request.authUser.uid);
    if (!roles.length) return response.status(403).json({ error: 'No active university role is assigned to this account.' });

    const requestedAssignmentId = typeof request.query.assignmentId === 'string'
      ? request.query.assignmentId.slice(0, 180)
      : '';
    const selectedRole = roles.find((role) => role.id === requestedAssignmentId) || roles[0];
    const dashboard = await buildScope(selectedRole);
    if (!dashboard) return response.status(403).json({ error: 'This role scope is no longer available. Contact your university administrator.' });

    const counts = {
      departments: dashboard.departments.length,
      programs: dashboard.programs.length,
      academicYears: dashboard.academicYears.length,
      semesters: dashboard.semesters.length,
      divisions: dashboard.divisions.length,
      subjects: dashboard.subjects.length,
      offerings: dashboard.offerings.length,
      students: dashboard.people.filter((person) => person.role === 'student').length,
      faculty: dashboard.people.filter((person) => ['subject_teacher', 'class_teacher', 'subject_coordinator', 'hod'].includes(person.role)).length,
    };
    const [items, submissions, attendance] = await Promise.all([
      getContentForScope(selectedRole, dashboard),
      getSubmissionsForScope(selectedRole, dashboard, request.authUser.uid),
      getAttendanceForScope(selectedRole, dashboard, request.authUser.uid),
    ]);
    const canViewAnalysis = ['school_admin', 'dean', 'hod'].includes(selectedRole.role);
    const analysis = canViewAnalysis
      ? calculateAcademicMetrics(dashboard.subjects, dashboard.offerings, dashboard.people, items, submissions, attendance)
      : null;
    const submissionCounts = canViewAnalysis
      ? submissions.reduce((countsByItem, submission) => {
        countsByItem[submission.itemId] = (countsByItem[submission.itemId] || 0) + 1;
        return countsByItem;
      }, {})
      : {};
    const coordinatorStudentCount = selectedRole.role === 'subject_coordinator'
      ? (await Promise.all(dashboard.divisions.map((division) => getRelatedRoleDocs('divisionId', division.id))))
        .reduce((total, roleDocs) => total + roleDocs.filter((doc) => doc.data()?.role === 'student').length, 0)
      : null;
    if (coordinatorStudentCount !== null) counts.students = coordinatorStudentCount;
    const canCreateCourseContent = ['subject_teacher', 'subject_coordinator'].includes(selectedRole.role)
      && dashboard.offerings.length > 0;
    const canPostAnnouncements = ['school_admin', 'dean', 'hod', 'class_teacher'].includes(selectedRole.role)
      && dashboard.offerings.length > 0;
    return response.json({
      user: { uid: request.authUser.uid, email: request.authUser.email || null },
      availableRoles: roles.map((role) => ({ id: role.id, role: role.role, roleLabel: role.roleLabel, scopeName: role.scopeName })),
      ...dashboard,
      counts,
      items,
      submissions: canViewAnalysis ? [] : submissions,
      submissionCounts,
      attendance: canViewAnalysis
        ? attendance.map(({ records = [], ...session }) => ({
          ...session,
          records: records.map(({ status }) => ({ status })),
        }))
        : attendance,
      analysis,
      capabilities: {
        createCourseContent: canCreateCourseContent,
        postAnnouncements: canPostAnnouncements,
        gradeAssignments: ['subject_teacher', 'subject_coordinator'].includes(selectedRole.role),
        viewGradebook: ['student', 'subject_teacher', 'subject_coordinator'].includes(selectedRole.role),
        viewAttendance: supportedRoles.has(selectedRole.role),
        markAttendance: ['class_teacher', 'subject_teacher', 'subject_coordinator'].includes(selectedRole.role),
        viewAnalysis: canViewAnalysis,
      },
      dataLimits: { recordsPerList: MAX_SCOPE_RECORDS, people: MAX_SCOPE_PEOPLE },
    });
  } catch (error) {
    console.error('Portal dashboard read failed:', error?.code || error?.name || 'unknown-error');
    return response.status(503).json({ error: 'Your learning workspace could not be loaded. Refresh or contact support.' });
  }
});

router.post('/attendance', async (request, response) => {
  if (!adminDb) return response.status(503).json({ error: 'Supabase Postgres is not configured for the learning portal.' });
  try {
    const offering = await getRecord('offerings', cleanText(request.body?.offeringId, 180));
    if (!offering) return response.status(404).json({ error: 'Choose an active teaching group.' });
    if (!await hasManagementAccess(request.authUser.uid, offering, 'attendance')) {
      return response.status(403).json({ error: 'Your assigned role cannot record attendance for this teaching group.' });
    }

    const sessionDate = cleanText(request.body?.sessionDate, 10);
    const title = cleanText(request.body?.title || 'Class attendance', 120);
    const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(sessionDate);
    const parsedDate = dateMatch ? new Date(`${sessionDate}T00:00:00.000Z`) : null;
    if (!parsedDate || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== sessionDate) {
      return response.status(400).json({ error: 'Choose a valid class date.' });
    }
    if (sessionDate > indiaDateString()) {
      return response.status(400).json({ error: 'Attendance can only be recorded for today or an earlier date.' });
    }
    if (title.length < 2) return response.status(400).json({ error: 'Enter a session label.' });
    const records = await validateAttendanceRecords(offering, request.body?.records);

    const sessionId = `${offering.id}_${sessionDate}`;
    const sessionRef = adminDb.collection('attendanceSessions').doc(sessionId);
    const auditRef = adminDb.collection('adminAuditLogs').doc();
    const createdAt = FieldValue.serverTimestamp();
    const session = {
      offeringId: offering.id,
      offeringName: offering.name || `${offering.subjectName || 'Subject'} · ${offering.divisionName || 'Division'}`,
      subjectId: offering.subjectId,
      subjectName: offering.subjectName || '',
      divisionId: offering.divisionId,
      divisionName: offering.divisionName || '',
      schoolId: offering.schoolId,
      departmentId: offering.departmentId,
      universityId: UNIVERSITY_ID,
      sessionDate,
      title,
      records,
      recordedBy: request.authUser.uid,
      createdAt,
      updatedAt: createdAt,
    };
    await adminDb.runTransaction(async (transaction) => {
      const existing = await transaction.get(sessionRef);
      if (existing.exists) throw Object.assign(new Error('Attendance has already been recorded for this teaching group and date.'), { statusCode: 409 });
      transaction.create(sessionRef, session);
      transaction.create(auditRef, {
        actorUid: request.authUser.uid,
        actorEmail: request.authUser.email || null,
        action: 'attendance.record',
        targetType: 'attendanceSession',
        targetId: sessionId,
        details: { offeringId: offering.id, divisionId: offering.divisionId, sessionDate, studentCount: records.length },
        createdAt,
      });
    });
    return response.status(201).json({ session: serializeAttendance(await sessionRef.get()) });
  } catch (error) {
    if (error?.statusCode) return response.status(error.statusCode).json({ error: error.message });
    if (error?.code === 6 || error?.code === 'already-exists') return response.status(409).json({ error: 'Attendance has already been recorded for this teaching group and date.' });
    console.error('Attendance record failed:', error?.code || error?.name || 'unknown-error');
    return response.status(503).json({ error: 'Attendance could not be saved. Refresh and try again.' });
  }
});

router.patch('/attendance/:sessionId', async (request, response) => {
  if (!adminDb) return response.status(503).json({ error: 'Supabase Postgres is not configured for the learning portal.' });
  try {
    const sessionRef = adminDb.collection('attendanceSessions').doc(cleanText(request.params.sessionId, 180));
    const sessionSnapshot = await sessionRef.get();
    if (!sessionSnapshot.exists || sessionSnapshot.data()?.universityId !== UNIVERSITY_ID) {
      return response.status(404).json({ error: 'Attendance register was not found.' });
    }
    const session = sessionSnapshot.data();
    const offering = await getRecord('offerings', session.offeringId);
    if (!offering || !await hasManagementAccess(request.authUser.uid, offering, 'attendance')) {
      return response.status(403).json({ error: 'Your assigned role cannot update this attendance register.' });
    }
    const title = cleanText(request.body?.title, 120);
    if (title.length < 2) return response.status(400).json({ error: 'Enter a session label.' });
    const records = await validateAttendanceRecords(offering, request.body?.records);
    const auditRef = adminDb.collection('adminAuditLogs').doc();
    const updatedAt = FieldValue.serverTimestamp();
    await adminDb.runTransaction(async (transaction) => {
      const latest = await transaction.get(sessionRef);
      if (!latest.exists || latest.data()?.universityId !== UNIVERSITY_ID || latest.data()?.offeringId !== offering.id) {
        throw Object.assign(new Error('This attendance register changed. Refresh and try again.'), { statusCode: 409 });
      }
      transaction.update(sessionRef, {
        title,
        records,
        updatedAt,
        updatedBy: request.authUser.uid,
      });
      transaction.create(auditRef, {
        actorUid: request.authUser.uid,
        actorEmail: request.authUser.email || null,
        action: 'attendance.update',
        targetType: 'attendanceSession',
        targetId: sessionRef.id,
        details: { offeringId: offering.id, divisionId: offering.divisionId, sessionDate: session.sessionDate, studentCount: records.length },
        createdAt: updatedAt,
      });
    });
    return response.json({ session: serializeAttendance(await sessionRef.get()) });
  } catch (error) {
    if (error?.statusCode) return response.status(error.statusCode).json({ error: error.message });
    console.error('Attendance update failed:', error?.code || error?.name || 'unknown-error');
    return response.status(503).json({ error: 'Attendance could not be updated. Refresh and try again.' });
  }
});

router.post('/items', async (request, response) => {
  if (!adminDb) return response.status(503).json({ error: 'Supabase Postgres is not configured for the learning portal.' });
  try {
    const offering = await getRecord('offerings', cleanText(request.body?.offeringId, 180));
    if (!offering) return response.status(404).json({ error: 'Choose an active subject offering.' });
    const validated = validateItemInput(request.body);
    if (!await hasManagementAccess(request.authUser.uid, offering, validated.itemType)) {
      return response.status(403).json({ error: 'Your assigned role cannot publish this item to the selected teaching group.' });
    }
    if (validated.status === 'published' && validated.dueAt && validated.dueAt.toDate() <= new Date()) {
      return response.status(400).json({ error: 'A published item needs a future due date.' });
    }
    const itemRef = adminDb.collection('learningItems').doc();
    const auditRef = adminDb.collection('adminAuditLogs').doc();
    const now = FieldValue.serverTimestamp();
    const itemData = {
      ...validated,
      offeringId: offering.id,
      offeringName: offering.name,
      subjectId: offering.subjectId,
      subjectName: offering.subjectName,
      subjectCode: offering.subjectCode,
      divisionId: offering.divisionId,
      divisionName: offering.divisionName,
      programId: offering.programId,
      programName: offering.programName,
      semesterId: offering.semesterId,
      semesterName: offering.semesterName,
      academicYearId: offering.academicYearId,
      academicYearName: offering.academicYearName,
      schoolId: offering.schoolId,
      departmentId: offering.departmentId,
      universityId: UNIVERSITY_ID,
      createdBy: request.authUser.uid,
      createdByName: cleanText(request.authUser.name, 100) || 'MIT ADT faculty',
      createdAt: now,
      updatedAt: now,
      publishedAt: validated.status === 'published' ? now : null,
    };
    await adminDb.runTransaction(async (transaction) => {
      transaction.create(itemRef, itemData);
      transaction.create(auditRef, {
        actorUid: request.authUser.uid,
        actorEmail: request.authUser.email || null,
        action: 'learningItem.create',
        targetType: 'learningItem',
        targetId: itemRef.id,
        details: { itemType: validated.itemType, status: validated.status, offeringId: offering.id },
        createdAt: now,
      });
    });
    const saved = await itemRef.get();
    return response.status(201).json({ item: serializeLearningItem(saved, { includeAnswerKey: true }) });
  } catch (error) {
    if (error?.statusCode) return response.status(error.statusCode).json({ error: error.message });
    console.error('Learning item create failed:', error?.code || error?.name || 'unknown-error');
    return response.status(503).json({ error: 'The course item could not be saved. Refresh and try again.' });
  }
});

router.post('/items/:itemId/publish', async (request, response) => {
  if (!adminDb) return response.status(503).json({ error: 'Supabase Postgres is not configured for the learning portal.' });
  try {
    const item = await getRecord('learningItems', cleanText(request.params.itemId, 180));
    if (!item) return response.status(404).json({ error: 'Course item was not found.' });
    const offering = await getRecord('offerings', item.offeringId);
    if (!offering || !await hasManagementAccess(request.authUser.uid, offering, item.itemType)) {
      return response.status(403).json({ error: 'You cannot publish this course item.' });
    }
    if (item.status !== 'draft') return response.status(409).json({ error: 'Only draft items can be published.' });
    if (item.dueAt?.toDate?.() <= new Date()) return response.status(400).json({ error: 'A draft with a past deadline cannot be published.' });
    const itemRef = adminDb.collection('learningItems').doc(item.id);
    const auditRef = adminDb.collection('adminAuditLogs').doc();
    const now = FieldValue.serverTimestamp();
    await adminDb.runTransaction(async (transaction) => {
      const latest = await transaction.get(itemRef);
      if (!latest.exists || latest.data()?.status !== 'draft') {
        throw Object.assign(new Error('This item is no longer a draft.'), { statusCode: 409 });
      }
      transaction.update(itemRef, { status: 'published', publishedAt: now, updatedAt: now });
      transaction.create(auditRef, {
        actorUid: request.authUser.uid,
        actorEmail: request.authUser.email || null,
        action: 'learningItem.publish',
        targetType: 'learningItem',
        targetId: item.id,
        details: { offeringId: offering.id },
        createdAt: now,
      });
    });
    return response.json({ item: serializeLearningItem(await itemRef.get(), { includeAnswerKey: true }) });
  } catch (error) {
    if (error?.statusCode) return response.status(error.statusCode).json({ error: error.message });
    console.error('Learning item publish failed:', error?.code || error?.name || 'unknown-error');
    return response.status(503).json({ error: 'The course item could not be published. Refresh and try again.' });
  }
});

router.patch('/items/:itemId', async (request, response) => {
  if (!adminDb) return response.status(503).json({ error: 'Supabase Postgres is not configured for the learning portal.' });
  try {
    const item = await getRecord('learningItems', cleanText(request.params.itemId, 180));
    if (!item) return response.status(404).json({ error: 'Course item was not found.' });
    if (item.status !== 'draft') return response.status(409).json({ error: 'Only draft items can be edited.' });
    const offering = await getRecord('offerings', item.offeringId);
    if (!offering || !await hasManagementAccess(request.authUser.uid, offering, item.itemType)) {
      return response.status(403).json({ error: 'You cannot edit this course item.' });
    }
    const validated = validateItemInput({ ...request.body, itemType: item.itemType });
    if (validated.status === 'published' && validated.dueAt && validated.dueAt.toDate() <= new Date()) {
      return response.status(400).json({ error: 'A published item needs a future due date.' });
    }
    const itemRef = adminDb.collection('learningItems').doc(item.id);
    const auditRef = adminDb.collection('adminAuditLogs').doc();
    const now = FieldValue.serverTimestamp();
    await adminDb.runTransaction(async (transaction) => {
      const latest = await transaction.get(itemRef);
      if (!latest.exists || latest.data()?.status !== 'draft') {
        throw Object.assign(new Error('This item is no longer a draft.'), { statusCode: 409 });
      }
      transaction.update(itemRef, {
        ...validated,
        updatedAt: now,
        ...(validated.status === 'published' ? { publishedAt: now } : {}),
      });
      transaction.create(auditRef, {
        actorUid: request.authUser.uid,
        actorEmail: request.authUser.email || null,
        action: 'learningItem.update',
        targetType: 'learningItem',
        targetId: item.id,
        details: { itemType: item.itemType, status: validated.status, offeringId: offering.id },
        createdAt: now,
      });
    });
    return response.json({ item: serializeLearningItem(await itemRef.get(), { includeAnswerKey: true }) });
  } catch (error) {
    if (error?.statusCode) return response.status(error.statusCode).json({ error: error.message });
    console.error('Learning item update failed:', error?.code || error?.name || 'unknown-error');
    return response.status(503).json({ error: 'The course item could not be updated. Refresh and try again.' });
  }
});

router.post('/items/:itemId/submissions', async (request, response) => {
  if (!adminDb) return response.status(503).json({ error: 'Supabase Postgres is not configured for the learning portal.' });
  try {
    const itemRef = adminDb.collection('learningItems').doc(cleanText(request.params.itemId, 180));
    const itemSnapshot = await itemRef.get();
    if (!itemSnapshot.exists || itemSnapshot.data()?.universityId !== UNIVERSITY_ID) {
      return response.status(404).json({ error: 'Course item was not found.' });
    }
    const item = serialize(itemSnapshot);
    const studentRoles = await listRolesForUser(request.authUser.uid);
    if (!studentRoles.some((role) => role.role === 'student' && role.scopeId === item.divisionId)) {
      return response.status(403).json({ error: 'This item is not assigned to your student division.' });
    }
    if (item.status !== 'published' || !['quiz', 'assignment'].includes(item.itemType)) {
      return response.status(409).json({ error: 'Only published quizzes and assignments accept submissions.' });
    }
    if (item.dueAt?.toDate?.() <= new Date()) return response.status(409).json({ error: 'The submission deadline has passed.' });

    let answers = [];
    let answerText = '';
    if (item.itemType === 'quiz') {
      if (!Array.isArray(request.body?.answers) || request.body.answers.length !== item.questions?.length) {
        return response.status(400).json({ error: 'Answer every quiz question before submitting.' });
      }
      if (request.body.answers.some((answer) => !Number.isInteger(answer))) {
        return response.status(400).json({ error: 'Choose a valid option for every quiz question.' });
      }
      answers = [...request.body.answers];
      if (answers.some((answer, index) => answer < 0 || answer >= item.questions[index].choices.length)) {
        return response.status(400).json({ error: 'Choose a valid option for every quiz question.' });
      }
    } else {
      answerText = typeof request.body?.answerText === 'string' ? request.body.answerText.trim().slice(0, 10000) : '';
      if (answerText.length < 2) return response.status(400).json({ error: 'Enter your assignment response before submitting.' });
    }

    const submissionId = `${item.id}_${request.authUser.uid}`;
    const submissionRef = adminDb.collection('learningSubmissions').doc(submissionId);
    const auditRef = adminDb.collection('adminAuditLogs').doc();
    const savedAt = FieldValue.serverTimestamp();
    let savedSubmission;
    await adminDb.runTransaction(async (transaction) => {
      const [latestItem, existing] = await Promise.all([transaction.get(itemRef), transaction.get(submissionRef)]);
      if (!latestItem.exists || latestItem.data()?.status !== 'published') {
        throw Object.assign(new Error('This course item is no longer accepting submissions.'), { statusCode: 409 });
      }
      if (existing.exists) throw Object.assign(new Error('You have already submitted this item.'), { statusCode: 409 });
      const latestData = latestItem.data();
      if (latestData.dueAt?.toDate?.() <= new Date()) {
        throw Object.assign(new Error('The submission deadline has passed.'), { statusCode: 409 });
      }
      let score = null;
      let maxPoints = Number(latestData.maxPoints) || 0;
      let status = 'submitted';
      if (latestData.itemType === 'quiz') {
        score = latestData.questions.reduce((total, question, index) => total + (answers[index] === question.answerIndex ? Number(question.points) || 0 : 0), 0);
        status = 'graded';
      }
      savedSubmission = {
        itemId: item.id,
        itemTitle: latestData.title,
        itemType: latestData.itemType,
        offeringId: latestData.offeringId,
        divisionId: latestData.divisionId,
        subjectId: latestData.subjectId,
        universityId: UNIVERSITY_ID,
        studentUid: request.authUser.uid,
        studentName: cleanText(request.authUser.name, 100) || 'Student',
        answers: latestData.itemType === 'quiz' ? answers : [],
        answerText: latestData.itemType === 'assignment' ? answerText : '',
        score,
        maxPoints,
        feedback: '',
        status,
        submittedAt: savedAt,
        gradedAt: latestData.itemType === 'quiz' ? savedAt : null,
        gradedBy: null,
      };
      transaction.create(submissionRef, savedSubmission);
      transaction.create(auditRef, {
        actorUid: request.authUser.uid,
        action: 'learningItem.submit',
        targetType: 'learningItem',
        targetId: item.id,
        details: { itemType: latestData.itemType, offeringId: latestData.offeringId },
        createdAt: savedAt,
      });
    });
    return response.status(201).json({ submission: serializeSubmission(await submissionRef.get()) });
  } catch (error) {
    if (error?.statusCode) return response.status(error.statusCode).json({ error: error.message });
    if (error?.code === 6 || error?.code === 'already-exists') return response.status(409).json({ error: 'A submission already exists for this item.' });
    console.error('Learning item submission failed:', error?.code || error?.name || 'unknown-error');
    return response.status(503).json({ error: 'Your submission could not be saved. Refresh and try again.' });
  }
});

router.patch('/submissions/:submissionId/grade', async (request, response) => {
  if (!adminDb) return response.status(503).json({ error: 'Supabase Postgres is not configured for the learning portal.' });
  try {
    const submissionRef = adminDb.collection('learningSubmissions').doc(cleanText(request.params.submissionId, 180));
    const submissionSnapshot = await submissionRef.get();
    if (!submissionSnapshot.exists || submissionSnapshot.data()?.universityId !== UNIVERSITY_ID) {
      return response.status(404).json({ error: 'Submission was not found.' });
    }
    const submission = submissionSnapshot.data();
    const item = await getRecord('learningItems', submission.itemId);
    if (!item || item.itemType !== 'assignment') return response.status(409).json({ error: 'Only written assignments can be manually graded.' });
    const offering = await getRecord('offerings', submission.offeringId);
    const roles = await listRolesForUser(request.authUser.uid);
    if (!offering || !roles.some((role) => ['subject_teacher', 'subject_coordinator'].includes(role.role) && canManageOffering(role, offering, 'assignment'))) {
      return response.status(403).json({ error: 'Your assigned role cannot grade this assignment.' });
    }
    const score = Number(request.body?.score);
    const feedback = typeof request.body?.feedback === 'string' ? request.body.feedback.trim().slice(0, 2000) : '';
    if (!Number.isInteger(score) || score < 0 || score > Number(item.maxPoints)) {
      return response.status(400).json({ error: `Score must be a whole number from 0 to ${item.maxPoints}.` });
    }
    const auditRef = adminDb.collection('adminAuditLogs').doc();
    const gradedAt = FieldValue.serverTimestamp();
    await adminDb.runTransaction(async (transaction) => {
      const latest = await transaction.get(submissionRef);
      if (!latest.exists || latest.data()?.offeringId !== offering.id) {
        throw Object.assign(new Error('Submission changed. Refresh and try again.'), { statusCode: 409 });
      }
      transaction.update(submissionRef, {
        score,
        feedback,
        status: 'graded',
        gradedAt,
        gradedBy: request.authUser.uid,
      });
      transaction.create(auditRef, {
        actorUid: request.authUser.uid,
        actorEmail: request.authUser.email || null,
        action: 'learningSubmission.grade',
        targetType: 'learningSubmission',
        targetId: submissionRef.id,
        details: { itemId: item.id, offeringId: offering.id, score, maxPoints: item.maxPoints },
        createdAt: gradedAt,
      });
    });
    return response.json({ submission: serializeSubmission(await submissionRef.get()) });
  } catch (error) {
    if (error?.statusCode) return response.status(error.statusCode).json({ error: error.message });
    console.error('Learning submission grade failed:', error?.code || error?.name || 'unknown-error');
    return response.status(503).json({ error: 'The grade could not be saved. Refresh and try again.' });
  }
});

export default router;
