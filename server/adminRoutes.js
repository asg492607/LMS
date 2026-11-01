import { Router } from 'express';
import { FieldValue, adminAuth, adminDb, UNIVERSITY_ID, UNIVERSITY_NAME } from './supabaseDb.js';

const router = Router();
const MAX_NAME = 100;
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,23}$/;
const DIVISION_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,7}$/;
const MAX_PROGRAM_YEARS = 8;
const MAX_DIVISIONS_PER_SEMESTER = 20;
const MAX_SUBJECTS_PER_SEMESTER = 100;

const roleScopes = {
  school_admin: { label: 'School admin', scopeType: 'school', collection: 'schools' },
  dean: { label: 'Dean', scopeType: 'school', collection: 'schools' },
  hod: { label: 'Head of department', scopeType: 'department', collection: 'departments' },
  subject_coordinator: { label: 'Subject coordinator', scopeType: 'subject', collection: 'subjects' },
  subject_teacher: { label: 'Subject teacher', scopeType: 'offering', collection: 'offerings' },
  class_teacher: { label: 'Class teacher', scopeType: 'division', collection: 'divisions' },
  student: { label: 'Student', scopeType: 'division', collection: 'divisions' },
};

function cleanText(value, maxLength = MAX_NAME) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function cleanCode(value) {
  return cleanText(value, 24).toUpperCase();
}

function validName(value) {
  const name = cleanText(value);
  return name.length >= 2 ? name : '';
}

function isStrongInitialPassword(password) {
  return typeof password === 'string'
    && password.length >= 12
    && password.length <= 128
    && /[a-z]/.test(password)
    && /[A-Z]/.test(password)
    && /\d/.test(password)
    && /[^A-Za-z0-9]/.test(password);
}

function recordId(parent, code) {
  return `${parent}_${code.toLowerCase()}`;
}

function serialize(snapshot) {
  const data = snapshot.data() || {};
  const createdAt = data.createdAt?.toDate?.().toISOString?.() || null;
  return { id: snapshot.id, ...data, createdAt };
}

function ensureDb(response) {
  if (!adminDb) {
    response.status(503).json({ error: 'The Postgres LMS store is not configured.' });
    return false;
  }
  return true;
}

function ensureAuthAdmin(response) {
  if (!adminAuth) {
    response.status(503).json({ error: 'Account provisioning is unavailable. Configure SUPABASE_SECRET_KEY on the server only.' });
    return false;
  }
  return true;
}

async function auditInTransaction(transaction, request, action, targetType, targetId, details = {}) {
  const auditRef = adminDb.collection('adminAuditLogs').doc();
  transaction.create(auditRef, {
    actorUid: request.authUser.uid,
    actorEmail: request.authUser.email || null,
    action,
    targetType,
    targetId,
    details,
    createdAt: FieldValue.serverTimestamp(),
  });
}

async function createUniqueRecord(request, collection, id, data, action, targetType, details) {
  const ref = adminDb.collection(collection).doc(id);
  await adminDb.runTransaction(async (transaction) => {
    const existing = await transaction.get(ref);
    if (existing.exists) {
      const duplicate = new Error('already-exists');
      duplicate.code = 'already-exists';
      throw duplicate;
    }
    transaction.create(ref, data);
    await auditInTransaction(transaction, request, action, targetType, id, details);
  });
  return ref;
}

function reportWriteError(response, error, description) {
  if (error?.code === 'already-exists' || error?.code === 6) {
    return response.status(409).json({ error: 'That code or assignment already exists.' });
  }
  return response.status(500).json({ error: `${description} could not be saved. Check the Postgres database and try again.` });
}

async function listCollection(collection, field, value) {
  let query = adminDb.collection(collection);
  if (field) query = query.where(field, '==', value);
  const result = await query.limit(500).get();
  return result.docs.map(serialize);
}

function validationError(message, status = 400, code = 'invalid-argument') {
  const error = new Error(message);
  error.statusCode = status;
  error.code = code;
  return error;
}

async function getSchoolByCode(code) {
  const clean = cleanCode(code);
  if (!CODE_PATTERN.test(clean)) throw validationError('Enter a valid schoolCode.');
  const snapshot = await adminDb.collection('schools').doc(recordId(UNIVERSITY_ID, clean)).get();
  if (!snapshot.exists || snapshot.data().universityId !== UNIVERSITY_ID) {
    throw validationError(`School code ${clean} was not found.`, 404, 'not-found');
  }
  return { id: snapshot.id, ...snapshot.data() };
}

async function getDepartmentByCodes(schoolCode, departmentCode) {
  const school = await getSchoolByCode(schoolCode);
  const clean = cleanCode(departmentCode);
  if (!CODE_PATTERN.test(clean)) throw validationError('Enter a valid departmentCode.');
  const snapshot = await adminDb.collection('departments').doc(recordId(school.id, clean)).get();
  if (!snapshot.exists || snapshot.data().universityId !== UNIVERSITY_ID) {
    throw validationError(`Department code ${clean} was not found under school ${school.code}.`, 404, 'not-found');
  }
  return { id: snapshot.id, ...snapshot.data() };
}

function academicYearLabel(yearNumber) {
  return ['', 'FY', 'SY', 'TY', 'LY'][yearNumber] || `Year ${yearNumber}`;
}

function getYearNumber(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= MAX_PROGRAM_YEARS ? number : 0;
}

async function createProgramRecord(request, departmentId, input) {
  const cleanDepartmentId = cleanText(departmentId, 128);
  const name = validName(input?.name);
  const code = cleanCode(input?.code);
  const intakeYear = Number(input?.intakeYear);
  const graduationYear = Number(input?.graduationYear);
  const durationYears = graduationYear - intakeYear;
  if (!cleanDepartmentId || cleanDepartmentId.includes('/') || !name || !CODE_PATTERN.test(code)
      || !Number.isInteger(intakeYear) || !Number.isInteger(graduationYear)
      || intakeYear < 2000 || graduationYear > 2100 || durationYears < 1 || durationYears > MAX_PROGRAM_YEARS) {
    throw validationError('Enter a program name, code, intake year, and a graduation year 1–8 years after intake.');
  }
  const departmentSnapshot = await adminDb.collection('departments').doc(cleanDepartmentId).get();
  if (!departmentSnapshot.exists || departmentSnapshot.data().universityId !== UNIVERSITY_ID) {
    throw validationError('Department not found under this university.', 404, 'not-found');
  }
  const department = departmentSnapshot.data();
  const id = recordId(cleanDepartmentId, code);
  const programRef = adminDb.collection('programs').doc(id);
  const yearRecords = [];
  for (let yearNumber = 1; yearNumber <= durationYears; yearNumber += 1) {
    const startYear = intakeYear + yearNumber - 1;
    const yearId = `${id}_y${yearNumber}`;
    const label = academicYearLabel(yearNumber);
    const yearData = {
      name: `${label} · ${startYear}-${startYear + 1}`,
      label,
      yearNumber,
      startYear,
      endYear: startYear + 1,
      programId: id,
      programName: name,
      departmentId: cleanDepartmentId,
      departmentName: department.name,
      schoolId: department.schoolId,
      schoolName: department.schoolName,
      universityId: UNIVERSITY_ID,
      createdBy: request.authUser.uid,
      createdAt: FieldValue.serverTimestamp(),
    };
    const semesters = [1, 2].map((semesterNumber) => {
      const semesterId = `${yearId}_s${semesterNumber}`;
      return {
        id: semesterId,
        ref: adminDb.collection('semesters').doc(semesterId),
        data: {
          name: `Semester ${semesterNumber}`,
          semesterNumber,
          academicYearId: yearId,
          academicYearName: yearData.name,
          yearNumber,
          programId: id,
          programName: name,
          departmentId: cleanDepartmentId,
          schoolId: department.schoolId,
          universityId: UNIVERSITY_ID,
          createdBy: request.authUser.uid,
          createdAt: FieldValue.serverTimestamp(),
        },
      };
    });
    yearRecords.push({
      id: yearId,
      ref: adminDb.collection('academicYears').doc(yearId),
      data: yearData,
      semesters,
    });
  }

  await adminDb.runTransaction(async (transaction) => {
    const existing = await transaction.get(programRef);
    if (existing.exists) throw validationError(`Program code ${code} already exists in this department.`, 409, 'already-exists');
    const programData = {
      name,
      code,
      intakeYear,
      graduationYear,
      durationYears,
      departmentId: cleanDepartmentId,
      departmentName: department.name,
      schoolId: department.schoolId,
      schoolName: department.schoolName,
      universityId: UNIVERSITY_ID,
      createdBy: request.authUser.uid,
      createdAt: FieldValue.serverTimestamp(),
    };
    transaction.create(programRef, programData);
    for (const year of yearRecords) {
      transaction.create(year.ref, year.data);
      for (const semester of year.semesters) transaction.create(semester.ref, semester.data);
    }
    await auditInTransaction(transaction, request, 'program.create', 'program', id, {
      departmentId: cleanDepartmentId,
      intakeYear,
      graduationYear,
      academicYearsCreated: durationYears,
      semestersCreated: durationYears * 2,
    });
  });

  return {
    id,
    name,
    code,
    intakeYear,
    graduationYear,
    durationYears,
    firstSemesterId: yearRecords[0]?.semesters[0]?.id || null,
    academicYearsCreated: durationYears,
    semestersCreated: durationYears * 2,
  };
}

async function getSemester(semesterId) {
  const cleanId = cleanText(semesterId, 180);
  if (!cleanId || cleanId.includes('/')) throw validationError('Choose a valid semester.');
  const snapshot = await adminDb.collection('semesters').doc(cleanId).get();
  if (!snapshot.exists || snapshot.data().universityId !== UNIVERSITY_ID) {
    throw validationError('Semester not found under this university.', 404, 'not-found');
  }
  return { id: snapshot.id, ...snapshot.data() };
}

function makeOfferingData(request, subject, division) {
  const id = recordId(subject.id, division.code);
  return {
    id,
    name: `${subject.name} · ${division.name}`,
    code: `${subject.code}-${division.code}`,
    subjectId: subject.id,
    subjectName: subject.name,
    subjectCode: subject.code,
    divisionId: division.id,
    divisionName: division.name,
    divisionCode: division.code,
    semesterId: subject.semesterId,
    semesterName: subject.semesterName,
    academicYearId: subject.academicYearId,
    academicYearName: subject.academicYearName,
    yearNumber: subject.yearNumber,
    semesterNumber: subject.semesterNumber,
    programId: subject.programId,
    programName: subject.programName,
    departmentId: subject.departmentId,
    schoolId: subject.schoolId,
    universityId: UNIVERSITY_ID,
    createdBy: request.authUser.uid,
    createdAt: FieldValue.serverTimestamp(),
  };
}

async function createDivisionRecord(request, semesterId, input) {
  const semester = await getSemester(semesterId);
  const name = validName(input?.name);
  const code = cleanCode(input?.code);
  if (!name || !DIVISION_CODE_PATTERN.test(code)) throw validationError('Enter a division name and a 1–8 character code.');
  const [divisionSnapshot, subjectSnapshot] = await Promise.all([
    adminDb.collection('divisions').where('semesterId', '==', semester.id).limit(MAX_DIVISIONS_PER_SEMESTER + 1).get(),
    adminDb.collection('subjects').where('semesterId', '==', semester.id).limit(MAX_SUBJECTS_PER_SEMESTER + 1).get(),
  ]);
  const divisions = divisionSnapshot.docs.filter((doc) => doc.data().universityId === UNIVERSITY_ID);
  const subjects = subjectSnapshot.docs.filter((doc) => doc.data().universityId === UNIVERSITY_ID).map((doc) => ({ id: doc.id, ...doc.data() }));
  if (divisions.length >= MAX_DIVISIONS_PER_SEMESTER) throw validationError(`A semester can have at most ${MAX_DIVISIONS_PER_SEMESTER} divisions.`, 409);
  if (subjects.length > MAX_SUBJECTS_PER_SEMESTER) throw validationError('This semester has too many subjects to create division offerings safely.', 409);
  const id = recordId(semester.id, code);
  const divisionRef = adminDb.collection('divisions').doc(id);
  const division = {
    id,
    name,
    code,
    semesterId: semester.id,
    semesterName: semester.name,
    semesterNumber: semester.semesterNumber,
    academicYearId: semester.academicYearId,
    academicYearName: semester.academicYearName,
    yearNumber: semester.yearNumber,
    programId: semester.programId,
    programName: semester.programName,
    departmentId: semester.departmentId,
    schoolId: semester.schoolId,
    universityId: UNIVERSITY_ID,
    createdBy: request.authUser.uid,
    createdAt: FieldValue.serverTimestamp(),
  };
  const offeringRefs = subjects.map((subject) => adminDb.collection('offerings').doc(recordId(subject.id, code)));
  const transactionRefs = [divisionRef, ...offeringRefs];
  await adminDb.runTransaction(async (transaction) => {
    const existingDocs = await Promise.all(transactionRefs.map((ref) => transaction.get(ref)));
    if (existingDocs[0].exists) throw validationError(`Division ${code} already exists in this semester.`, 409, 'already-exists');
    if (existingDocs.slice(1).some((doc) => doc.exists)) throw validationError('A subject offering already exists for this division code.', 409, 'already-exists');
    transaction.create(divisionRef, division);
    subjects.forEach((subject, index) => {
      const offeringRef = offeringRefs[index];
      transaction.create(offeringRef, makeOfferingData(request, subject, division));
    });
    await auditInTransaction(transaction, request, 'division.create', 'division', id, {
      semesterId: semester.id,
      offeringsCreated: subjects.length,
    });
  });
  return { ...division, createdAt: null, offeringsCreated: subjects.length };
}

async function createSemesterSubject(request, semesterId, input) {
  const semester = await getSemester(semesterId);
  const name = validName(input?.name);
  const code = cleanCode(input?.code);
  if (!name || !CODE_PATTERN.test(code)) throw validationError('Enter a subject name and a valid subject code.');
  const [subjectSnapshot, divisionSnapshot] = await Promise.all([
    adminDb.collection('subjects').where('semesterId', '==', semester.id).limit(MAX_SUBJECTS_PER_SEMESTER + 1).get(),
    adminDb.collection('divisions').where('semesterId', '==', semester.id).limit(MAX_DIVISIONS_PER_SEMESTER + 1).get(),
  ]);
  const subjects = subjectSnapshot.docs.filter((doc) => doc.data().universityId === UNIVERSITY_ID);
  const divisions = divisionSnapshot.docs.filter((doc) => doc.data().universityId === UNIVERSITY_ID).map((doc) => ({ id: doc.id, ...doc.data() }));
  if (subjects.length >= MAX_SUBJECTS_PER_SEMESTER) throw validationError(`A semester can have at most ${MAX_SUBJECTS_PER_SEMESTER} subjects.`, 409);
  if (divisions.length > MAX_DIVISIONS_PER_SEMESTER) throw validationError('This semester has too many divisions to create subject offerings safely.', 409);
  const id = recordId(semester.id, code);
  const subjectRef = adminDb.collection('subjects').doc(id);
  const subject = {
    id,
    name,
    code,
    semesterId: semester.id,
    semesterName: semester.name,
    semesterNumber: semester.semesterNumber,
    academicYearId: semester.academicYearId,
    academicYearName: semester.academicYearName,
    yearNumber: semester.yearNumber,
    programId: semester.programId,
    programName: semester.programName,
    departmentId: semester.departmentId,
    schoolId: semester.schoolId,
    universityId: UNIVERSITY_ID,
    createdBy: request.authUser.uid,
    createdAt: FieldValue.serverTimestamp(),
  };
  const offeringRefs = divisions.map((division) => adminDb.collection('offerings').doc(recordId(id, division.code)));
  await adminDb.runTransaction(async (transaction) => {
    const refs = [subjectRef, ...offeringRefs];
    const existingDocs = await Promise.all(refs.map((ref) => transaction.get(ref)));
    if (existingDocs[0].exists) throw validationError(`Subject code ${code} already exists in this semester.`, 409, 'already-exists');
    if (existingDocs.slice(1).some((doc) => doc.exists)) throw validationError('A subject offering already exists for this subject.', 409, 'already-exists');
    transaction.create(subjectRef, subject);
    divisions.forEach((division, index) => transaction.create(offeringRefs[index], makeOfferingData(request, subject, division)));
    await auditInTransaction(transaction, request, 'subject.create', 'subject', id, {
      semesterId: semester.id,
      offeringsCreated: divisions.length,
    });
  });
  return { ...subject, createdAt: null, offeringsCreated: divisions.length };
}

async function getProgramByCodes(schoolCode, departmentCode, programCode) {
  const department = await getDepartmentByCodes(schoolCode, departmentCode);
  const code = cleanCode(programCode);
  if (!CODE_PATTERN.test(code)) throw validationError('Enter a valid programCode.');
  const snapshot = await adminDb.collection('programs').doc(recordId(department.id, code)).get();
  if (!snapshot.exists || snapshot.data().universityId !== UNIVERSITY_ID) {
    throw validationError(`Program code ${code} was not found under ${department.name}.`, 404, 'not-found');
  }
  return { id: snapshot.id, ...snapshot.data() };
}

async function getProgramSemester(program, yearNumberValue, semesterNumberValue) {
  const yearNumber = getYearNumber(yearNumberValue);
  const semesterNumber = Number(semesterNumberValue);
  if (!yearNumber || yearNumber > program.durationYears || ![1, 2].includes(semesterNumber)) {
    throw validationError('Use a year within the program duration and semesterNumber 1 or 2.');
  }
  const academicYearId = `${program.id}_y${yearNumber}`;
  const id = `${academicYearId}_s${semesterNumber}`;
  const snapshot = await adminDb.collection('semesters').doc(id).get();
  if (!snapshot.exists || snapshot.data().universityId !== UNIVERSITY_ID) {
    throw validationError('Semester was not found. Register the program before its divisions or subjects.', 404, 'not-found');
  }
  return { id: snapshot.id, ...snapshot.data() };
}

async function createImportedDirectoryRow(request, row) {
  const type = cleanText(row?.type, 20).toLowerCase();
  const name = validName(row?.name);
  const code = cleanCode(row?.code);
  if (!['school', 'department', 'program', 'division', 'subject'].includes(type)) {
    throw validationError('type must be school, department, program, division, or subject.');
  }
  if (!name || !(type === 'division' ? DIVISION_CODE_PATTERN : CODE_PATTERN).test(code)) {
    throw validationError(type === 'division' ? 'Each division needs a valid name and 1–8 character code.' : 'Each row needs a valid name and a 2–24 character code.');
  }

  if (type === 'school') {
    const id = recordId(UNIVERSITY_ID, code);
    const data = {
      name,
      code,
      universityId: UNIVERSITY_ID,
      status: 'active',
      createdBy: request.authUser.uid,
      createdAt: FieldValue.serverTimestamp(),
    };
    const ref = adminDb.collection('schools').doc(id);
    const universityRef = adminDb.collection('universities').doc(UNIVERSITY_ID);
    await adminDb.runTransaction(async (transaction) => {
      const existing = await transaction.get(ref);
      if (existing.exists) throw validationError(`School code ${code} already exists.`, 409, 'already-exists');
      transaction.set(universityRef, {
        id: UNIVERSITY_ID,
        name: UNIVERSITY_NAME,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      transaction.create(ref, data);
      await auditInTransaction(transaction, request, 'school.create', 'school', id, { code, source: 'bulk-import' });
    });
    return { type, id, name, code };
  }

  const schoolCode = cleanCode(row.schoolCode);
  const school = await getSchoolByCode(schoolCode);
  if (type === 'department') {
    const id = recordId(school.id, code);
    const data = {
      name,
      code,
      universityId: UNIVERSITY_ID,
      schoolId: school.id,
      schoolName: school.name,
      createdBy: request.authUser.uid,
      createdAt: FieldValue.serverTimestamp(),
    };
    await createUniqueRecord(request, 'departments', id, data, 'department.create', 'department', { schoolId: school.id, code, source: 'bulk-import' });
    return { type, id, name, code, schoolCode: school.code };
  }

  const department = await getDepartmentByCodes(schoolCode, row.departmentCode);
  if (type === 'program') {
    return { type, ...(await createProgramRecord(request, department.id, row)) };
  }
  const program = await getProgramByCodes(schoolCode, row.departmentCode, row.programCode);
  const semester = await getProgramSemester(program, row.yearNumber, row.semesterNumber);
  if (type === 'division') return { type, ...(await createDivisionRecord(request, semester.id, row)) };
  return { type, ...(await createSemesterSubject(request, semester.id, row)) };
}

async function assignScopedRole(request, input) {
  const email = cleanText(input?.email, 254).toLowerCase();
  const displayName = validName(input?.displayName);
  const role = cleanText(input?.role, 40);
  const scopeId = cleanText(input?.scopeId, 128);
  const createAccount = input?.createAccount === true;
  const password = typeof input?.password === 'string' ? input.password : '';
  const identityConfirmed = input?.identityConfirmed === true;
  const roleConfig = roleScopes[role];
  if (!/^\S+@\S+\.\S+$/.test(email) || !displayName || !roleConfig || !scopeId || scopeId.includes('/')) {
    throw validationError('Enter an email, full name, valid role, and role scope.');
  }
  if (!adminAuth) {
    throw validationError('Account provisioning is unavailable. Configure SUPABASE_SECRET_KEY on the server only.', 503, 'auth-admin-not-configured');
  }
  if (createAccount && (!identityConfirmed || !isStrongInitialPassword(password))) {
    throw validationError('Confirm the user is authorized for this email and enter a 12–128 character password with uppercase and lowercase letters, a number, and a symbol.');
  }
  if (!createAccount && password) {
    throw validationError('This mode only assigns a role to an existing account. Choose “Create new account” to set an initial password.');
  }

  const scopeSnapshot = await adminDb.collection(roleConfig.collection).doc(scopeId).get();
  if (!scopeSnapshot.exists) throw validationError('The selected role scope was not found.', 404, 'not-found');
  const scope = scopeSnapshot.data();
  if (scope.universityId !== UNIVERSITY_ID) throw validationError('The selected scope is outside this university.', 404, 'not-found');

  let userRecord;
  let accountCreated = false;
  try {
    userRecord = await adminAuth.getUserByEmail(email);
  } catch (error) {
    if (error?.code !== 'auth/user-not-found') throw error;
    if (!createAccount) {
      throw validationError('No Supabase account exists for this email. Choose “Create new account” and set an initial password.', 404, 'not-found');
    }
    userRecord = await adminAuth.createUser({ email, displayName, password });
    accountCreated = true;
  }
  if (createAccount && !accountCreated) {
    throw validationError('This email already has a Supabase account. Choose “Assign role to existing account”; its password will not be changed.', 409, 'already-exists');
  }

  const userRef = adminDb.collection('users').doc(userRecord.uid);
  const roleRef = userRef.collection('roles').doc(`${role}_${scopeId}`);
  const roleData = {
    role,
    roleLabel: roleConfig.label,
    scopeType: roleConfig.scopeType,
    scopeId,
    scopeName: scope.name,
    universityId: UNIVERSITY_ID,
    schoolId: scope.schoolId || (roleConfig.scopeType === 'school' ? scopeId : null),
    departmentId: scope.departmentId || (roleConfig.scopeType === 'department' ? scopeId : null),
    programId: scope.programId || (roleConfig.scopeType === 'program' ? scopeId : null),
    academicYearId: scope.academicYearId || null,
    semesterId: scope.semesterId || (roleConfig.scopeType === 'semester' ? scopeId : null),
    divisionId: scope.divisionId || (roleConfig.scopeType === 'division' ? scopeId : null),
    subjectId: scope.subjectId || (roleConfig.scopeType === 'subject' ? scopeId : null),
    offeringId: roleConfig.scopeType === 'offering' ? scopeId : null,
    classId: null,
    createdBy: request.authUser.uid,
    createdAt: FieldValue.serverTimestamp(),
  };
  try {
    await adminDb.runTransaction(async (transaction) => {
      const existingRole = await transaction.get(roleRef);
      if (existingRole.exists) throw validationError('That role is already assigned for this scope.', 409, 'already-exists');
      transaction.set(userRef, {
        uid: userRecord.uid,
        email,
        displayName: userRecord.displayName || displayName,
        emailVerified: Boolean(userRecord.emailVerified),
        universityId: UNIVERSITY_ID,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      transaction.create(roleRef, roleData);
      await auditInTransaction(transaction, request, 'role.assign', 'user', userRecord.uid, { role, scopeId, email, source: 'admin-dashboard' });
    });
  } catch (error) {
    if (accountCreated) {
      try {
        await adminAuth.deleteUser(userRecord.uid);
      } catch {
        console.error('Could not clean up a pending LMS invitation after a failed role assignment.');
      }
    }
    throw error;
  }
  return {
    user: { uid: userRecord.uid, email, displayName: userRecord.displayName || displayName },
    role: roleData.roleLabel,
    scope: roleData.scopeName,
    accountCreated,
    nextStep: accountCreated
      ? 'Account created and email confirmed by the administrator. The person must change the temporary password after signing in.'
      : 'Existing account received the role. Its password and email-confirmation status were left unchanged.',
  };
}

async function previewBulkImport(kind, rows) {
  if (!['directory', 'roles'].includes(kind)) throw validationError('Import type must be directory or roles.');
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 250) {
    throw validationError('Choose a CSV with 1–250 data rows.');
  }

  const newSchools = new Map();
  const newDepartments = new Map();
  const newPrograms = new Map();
  const plannedSemesterCounts = new Map();
  const seenDocuments = new Set();
  const seenAssignments = new Set();
  const results = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] || {};
    try {
      if (kind === 'roles') {
        if (!adminAuth) throw validationError('Role imports need a server-side Supabase secret key.', 503, 'auth-admin-not-configured');
        const email = cleanText(row.email, 254).toLowerCase();
        const displayName = validName(row.displayName);
        const role = cleanText(row.role, 40);
        const scopeId = cleanText(row.scopeId, 128);
        const config = roleScopes[role];
        if (!/^\S+@\S+\.\S+$/.test(email) || !displayName || !config || !scopeId || scopeId.includes('/')) {
          throw validationError('Enter an email, full name, valid role, and scopeId.');
        }
        const scopeSnapshot = await adminDb.collection(config.collection).doc(scopeId).get();
        if (!scopeSnapshot.exists || scopeSnapshot.data().universityId !== UNIVERSITY_ID) {
          throw validationError('scopeId was not found under MIT ADT University.', 404, 'not-found');
        }
        const assignmentKey = `${email}:${role}:${scopeId}`;
        if (seenAssignments.has(assignmentKey)) throw validationError('The same role assignment appears more than once in this file.', 409, 'already-exists');
        seenAssignments.add(assignmentKey);
        let existingUser = null;
        try {
          existingUser = await adminAuth.getUserByEmail(email);
        } catch (error) {
          if (error?.code !== 'auth/user-not-found') throw error;
        }
        if (!existingUser) throw validationError('Bulk role imports assign existing accounts only. Create new accounts individually with a temporary password first.', 404, 'not-found');
        const roleRef = adminDb.collection('users').doc(existingUser.uid).collection('roles').doc(`${role}_${scopeId}`);
        if ((await roleRef.get()).exists) throw validationError('This user already has that role for the selected scope.', 409, 'already-exists');
        results.push({ row: index + 2, ok: true, summary: `${role} → ${scopeSnapshot.data().name}` });
        continue;
      }

      const type = cleanText(row.type, 20).toLowerCase();
      const name = validName(row.name);
      const code = cleanCode(row.code);
      if (!['school', 'department', 'program', 'division', 'subject'].includes(type)) {
        throw validationError('type must be school, department, program, division, or subject.');
      }
      if (!name || !(type === 'division' ? DIVISION_CODE_PATTERN : CODE_PATTERN).test(code)) {
        throw validationError(type === 'division' ? 'Enter a valid name and 1–8 character division code.' : 'Enter a valid name and 2–24 character code.');
      }

      let collection;
      let id;
      let summary;
      let semesterIdForRow = '';
      if (type === 'school') {
        collection = 'schools';
        id = recordId(UNIVERSITY_ID, code);
        summary = `School: ${name}`;
        if (newSchools.has(code)) throw validationError('School code appears more than once in this file.', 409, 'already-exists');
      } else {
        const schoolCode = cleanCode(row.schoolCode);
        let school = newSchools.get(schoolCode);
        if (!school) school = await getSchoolByCode(schoolCode);
        if (type === 'department') {
          collection = 'departments';
          id = recordId(school.id, code);
          summary = `Department: ${name} → ${school.name}`;
          if (newDepartments.has(`${school.id}:${code}`)) throw validationError('Department code appears more than once under this school in the file.', 409, 'already-exists');
        } else {
          const departmentCode = cleanCode(row.departmentCode);
          let department = newDepartments.get(`${school.id}:${departmentCode}`);
          if (!department) department = await getDepartmentByCodes(schoolCode, departmentCode);
          if (type === 'program') {
            const intakeYear = Number(row.intakeYear);
            const graduationYear = Number(row.graduationYear);
            const durationYears = graduationYear - intakeYear;
            if (!Number.isInteger(intakeYear) || !Number.isInteger(graduationYear)
                || intakeYear < 2000 || graduationYear > 2100 || durationYears < 1 || durationYears > MAX_PROGRAM_YEARS) {
              throw validationError('Program needs valid intakeYear and graduationYear 1–8 years later.');
            }
            collection = 'programs';
            id = recordId(department.id, code);
            summary = `Program: ${name} · ${intakeYear}-${graduationYear}`;
          } else {
            const programCode = cleanCode(row.programCode);
            let program = newPrograms.get(`${department.id}:${programCode}`);
            if (!program) program = await getProgramByCodes(schoolCode, departmentCode, programCode);
            const yearNumber = getYearNumber(row.yearNumber);
            const semesterNumber = Number(row.semesterNumber);
            if (!yearNumber || yearNumber > program.durationYears || ![1, 2].includes(semesterNumber)) {
              throw validationError('Use a year within the program duration and semesterNumber 1 or 2.');
            }
            const semesterId = `${program.id}_y${yearNumber}_s${semesterNumber}`;
            semesterIdForRow = semesterId;
            if (!newPrograms.has(`${department.id}:${programCode}`)) await getProgramSemester(program, yearNumber, semesterNumber);
            if (type === 'division' || type === 'subject') {
              let counts = plannedSemesterCounts.get(semesterId);
              if (!counts) {
                const [divisionDocs, subjectDocs] = await Promise.all([
                  adminDb.collection('divisions').where('semesterId', '==', semesterId).limit(MAX_DIVISIONS_PER_SEMESTER + 1).get(),
                  adminDb.collection('subjects').where('semesterId', '==', semesterId).limit(MAX_SUBJECTS_PER_SEMESTER + 1).get(),
                ]);
                counts = {
                  divisions: divisionDocs.docs.filter((doc) => doc.data().universityId === UNIVERSITY_ID).length,
                  subjects: subjectDocs.docs.filter((doc) => doc.data().universityId === UNIVERSITY_ID).length,
                };
                plannedSemesterCounts.set(semesterId, counts);
              }
              const currentCount = type === 'division' ? counts.divisions : counts.subjects;
              const limit = type === 'division' ? MAX_DIVISIONS_PER_SEMESTER : MAX_SUBJECTS_PER_SEMESTER;
              if (currentCount >= limit) {
                throw validationError(`A semester can have at most ${limit} ${type === 'division' ? 'divisions' : 'subjects'}.`, 409);
              }
            }
            collection = type === 'division' ? 'divisions' : 'subjects';
            id = recordId(semesterId, code);
            summary = type === 'division'
              ? `Division ${code} → ${program.name}, ${academicYearLabel(yearNumber)}, Semester ${semesterNumber}`
              : `Subject: ${name} → ${program.name}, ${academicYearLabel(yearNumber)}, Semester ${semesterNumber}`;
          }
        }
      }

      const documentKey = `${collection}:${id}`;
      if (seenDocuments.has(documentKey)) throw validationError('This code appears more than once under the same parent in the file.', 409, 'already-exists');
      seenDocuments.add(documentKey);
      if ((await adminDb.collection(collection).doc(id).get()).exists) {
        throw validationError(`Code ${code} already exists under this parent.`, 409, 'already-exists');
      }

      if (type === 'school') newSchools.set(code, { id, code, name });
      if (type === 'department') {
        const schoolCode = cleanCode(row.schoolCode);
        const school = newSchools.get(schoolCode) || await getSchoolByCode(schoolCode);
        newDepartments.set(`${school.id}:${code}`, { id, code, name, schoolId: school.id });
      }
      if (type === 'program') {
        const departmentCode = cleanCode(row.departmentCode);
        const schoolCode = cleanCode(row.schoolCode);
        const school = newSchools.get(schoolCode) || await getSchoolByCode(schoolCode);
        const department = newDepartments.get(`${school.id}:${departmentCode}`) || await getDepartmentByCodes(schoolCode, departmentCode);
        newPrograms.set(`${department.id}:${code}`, {
          id,
          code,
          name,
          durationYears: Number(row.graduationYear) - Number(row.intakeYear),
        });
      }
      const plannedCounts = plannedSemesterCounts.get(semesterIdForRow);
      if (type === 'division' && plannedCounts) plannedCounts.divisions += 1;
      if (type === 'subject' && plannedCounts) plannedCounts.subjects += 1;
      results.push({ row: index + 2, ok: true, summary });
    } catch (error) {
      results.push({ row: index + 2, ok: false, error: error.message || 'Row could not be validated.' });
    }
  }

  const valid = results.length === rows.length && results.every((result) => result.ok);
  return { kind, rowCount: rows.length, valid, results };
}

router.get('/dashboard', async (_request, response) => {
  if (!ensureDb(response)) return;
  try {
    const counts = await Promise.all([
      'schools', 'departments', 'programs', 'academicYears', 'semesters', 'divisions', 'subjects', 'offerings',
    ].map(async (collection) => {
      const result = await adminDb.collection(collection)
        .where('universityId', '==', UNIVERSITY_ID)
        .count()
        .get();
      return [collection, result.data().count];
    }));
    const members = await adminDb.collection('users').where('universityId', '==', UNIVERSITY_ID).count().get();
    return response.json({
      university: { id: UNIVERSITY_ID, name: UNIVERSITY_NAME },
      counts: { ...Object.fromEntries(counts), users: members.data().count },
      accountProvisioningConfigured: Boolean(adminAuth),
      roles: Object.entries(roleScopes).map(([id, value]) => ({ id, label: value.label, scopeType: value.scopeType })),
    });
  } catch {
    return response.status(503).json({ error: 'The Supabase Postgres database is unavailable. Check the backend connection.' });
  }
});

router.get('/catalog', async (_request, response) => {
  if (!ensureDb(response)) return;
  try {
    const [schools, departments, programs, academicYears, semesters, divisions, classes, subjects, offerings] = await Promise.all([
      listCollection('schools', 'universityId', UNIVERSITY_ID),
      listCollection('departments', 'universityId', UNIVERSITY_ID),
      listCollection('programs', 'universityId', UNIVERSITY_ID),
      listCollection('academicYears', 'universityId', UNIVERSITY_ID),
      listCollection('semesters', 'universityId', UNIVERSITY_ID),
      listCollection('divisions', 'universityId', UNIVERSITY_ID),
      listCollection('classes', 'universityId', UNIVERSITY_ID),
      listCollection('subjects', 'universityId', UNIVERSITY_ID),
      listCollection('offerings', 'universityId', UNIVERSITY_ID),
    ]);
    return response.json({ schools, departments, programs, academicYears, semesters, divisions, classes, subjects, offerings });
  } catch {
    return response.status(503).json({ error: 'School data is unavailable. Check the Postgres database connection.' });
  }
});

router.get('/role-assignments', async (_request, response) => {
  if (!ensureDb(response)) return;
  try {
    const result = await adminDb.collectionGroup('roles')
      .where('universityId', '==', UNIVERSITY_ID)
      .limit(500)
      .get();
    const roleDocs = result.docs.filter((doc) => doc.data()?.role !== 'platform_admin');
    const userRefs = [...new Map(roleDocs.map((doc) => [doc.ref.parent.parent.id, doc.ref.parent.parent])).values()];
    const userSnapshots = userRefs.length ? await adminDb.getAll(...userRefs) : [];
    const usersById = new Map(userSnapshots.map((doc) => [doc.id, doc.data() || {}]));
    const assignments = roleDocs.map((doc) => {
      const uid = doc.ref.parent.parent.id;
      return { id: doc.id, uid, ...(usersById.get(uid) || {}), ...serialize(doc) };
    });
    return response.json({ assignments });
  } catch {
    return response.status(503).json({ error: 'Role assignments are unavailable. Check the Postgres database connection.' });
  }
});

router.post('/import/preview', async (request, response) => {
  if (!ensureDb(response)) return;
  if (cleanText(request.body?.kind, 20).toLowerCase() === 'roles' && !ensureAuthAdmin(response)) return;
  try {
    return response.json(await previewBulkImport(request.body?.kind, request.body?.rows));
  } catch (error) {
    const status = error?.statusCode || 500;
    return response.status(status).json({ error: error?.statusCode ? error.message : 'The import preview could not be prepared.' });
  }
});

router.post('/import', async (request, response) => {
  if (!ensureDb(response)) return;
  const kind = cleanText(request.body?.kind, 20).toLowerCase();
  if (kind === 'roles' && !ensureAuthAdmin(response)) return;
  const rows = request.body?.rows;
  try {
    const preview = await previewBulkImport(kind, rows);
    if (!preview.valid) {
      return response.status(409).json({ error: 'Fix the invalid rows and preview the file again before importing.', preview });
    }
    const results = [];
    for (let index = 0; index < rows.length; index += 1) {
      try {
        const result = kind === 'roles'
          ? await assignScopedRole(request, rows[index])
          : await createImportedDirectoryRow(request, rows[index]);
        const summary = kind === 'roles'
          ? `${result.role} → ${result.scope} (${result.user.email})`
          : `${result.type}: ${result.name}`;
        results.push({ row: index + 2, ok: true, summary, accountCreated: result.accountCreated || false });
      } catch (error) {
        results.push({ row: index + 2, ok: false, error: error?.statusCode ? error.message : 'The row could not be saved.' });
      }
    }
    const succeeded = results.filter((result) => result.ok).length;
    return response.json({
      kind,
      processed: results.length,
      succeeded,
      failed: results.length - succeeded,
      results,
    });
  } catch (error) {
    const status = error?.statusCode || 500;
    return response.status(status).json({ error: error?.statusCode ? error.message : 'The import could not be completed.' });
  }
});

router.post('/schools', async (request, response) => {
  if (!ensureDb(response)) return;
  const name = validName(request.body?.name);
  const code = cleanCode(request.body?.code);
  if (!name || !CODE_PATTERN.test(code)) {
    return response.status(400).json({ error: 'Enter a school name and a 2–24 character code using letters, numbers, _ or -.' });
  }
  const id = recordId(UNIVERSITY_ID, code);
  const data = {
    name,
    code,
    universityId: UNIVERSITY_ID,
    status: 'active',
    createdBy: request.authUser.uid,
    createdAt: FieldValue.serverTimestamp(),
  };
  try {
    const ref = adminDb.collection('schools').doc(id);
    const universityRef = adminDb.collection('universities').doc(UNIVERSITY_ID);
    await adminDb.runTransaction(async (transaction) => {
      const existing = await transaction.get(ref);
      if (existing.exists) {
        const duplicate = new Error('already-exists');
        duplicate.code = 'already-exists';
        throw duplicate;
      }
      transaction.set(universityRef, {
        id: UNIVERSITY_ID,
        name: UNIVERSITY_NAME,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      transaction.create(ref, data);
      await auditInTransaction(transaction, request, 'school.create', 'school', id, { code });
    });
    return response.status(201).json({ school: { id, ...data, createdAt: null } });
  } catch (error) {
    return reportWriteError(response, error, 'School');
  }
});

router.post('/schools/:schoolId/departments', async (request, response) => {
  if (!ensureDb(response)) return;
  const schoolId = cleanText(request.params.schoolId, 128);
  const name = validName(request.body?.name);
  const code = cleanCode(request.body?.code);
  if (!schoolId || !name || !CODE_PATTERN.test(code)) {
    return response.status(400).json({ error: 'Select a school, enter a department name, and use a 2–24 character code with letters, numbers, hyphens, or underscores.' });
  }
  try {
    const schoolSnapshot = await adminDb.collection('schools').doc(schoolId).get();
    if (!schoolSnapshot.exists || schoolSnapshot.data().universityId !== UNIVERSITY_ID) {
      return response.status(404).json({ error: 'School not found under this university.' });
    }
    const school = schoolSnapshot.data();
    const id = recordId(schoolId, code);
    const data = {
      name,
      code,
      universityId: UNIVERSITY_ID,
      schoolId,
      schoolName: school.name,
      createdBy: request.authUser.uid,
      createdAt: FieldValue.serverTimestamp(),
    };
    await createUniqueRecord(request, 'departments', id, data, 'department.create', 'department', { schoolId, code });
    return response.status(201).json({ department: { id, ...data, createdAt: null } });
  } catch (error) {
    return reportWriteError(response, error, 'Department');
  }
});

router.post('/departments/:departmentId/programs', async (request, response) => {
  if (!ensureDb(response)) return;
  try {
    return response.status(201).json({ program: await createProgramRecord(request, request.params.departmentId, request.body) });
  } catch (error) {
    if (error?.statusCode) return response.status(error.statusCode).json({ error: error.message });
    return reportWriteError(response, error, 'Program');
  }
});

router.post('/semesters/:semesterId/divisions', async (request, response) => {
  if (!ensureDb(response)) return;
  try {
    return response.status(201).json({ division: await createDivisionRecord(request, request.params.semesterId, request.body) });
  } catch (error) {
    if (error?.statusCode) return response.status(error.statusCode).json({ error: error.message });
    return reportWriteError(response, error, 'Division');
  }
});

router.post('/semesters/:semesterId/subjects', async (request, response) => {
  if (!ensureDb(response)) return;
  try {
    return response.status(201).json({ subject: await createSemesterSubject(request, request.params.semesterId, request.body) });
  } catch (error) {
    if (error?.statusCode) return response.status(error.statusCode).json({ error: error.message });
    return reportWriteError(response, error, 'Subject');
  }
});

router.post('/departments/:departmentId/classes', async (request, response) => {
  if (!ensureDb(response)) return;
  const departmentId = cleanText(request.params.departmentId, 128);
  const name = validName(request.body?.name);
  const code = cleanCode(request.body?.code);
  const year = cleanText(request.body?.year, 20);
  const section = cleanText(request.body?.section, 20);
  if (!departmentId || !name || !CODE_PATTERN.test(code)) {
    return response.status(400).json({ error: 'Select a department and enter a valid class name and code.' });
  }
  try {
    const departmentSnapshot = await adminDb.collection('departments').doc(departmentId).get();
    if (!departmentSnapshot.exists || departmentSnapshot.data().universityId !== UNIVERSITY_ID) {
      return response.status(404).json({ error: 'Department not found under this university.' });
    }
    const department = departmentSnapshot.data();
    const id = recordId(departmentId, code);
    const data = {
      name,
      code,
      year,
      section,
      universityId: UNIVERSITY_ID,
      schoolId: department.schoolId,
      schoolName: department.schoolName,
      departmentId,
      departmentName: department.name,
      createdBy: request.authUser.uid,
      createdAt: FieldValue.serverTimestamp(),
    };
    await createUniqueRecord(request, 'classes', id, data, 'class.create', 'class', { departmentId, code });
    return response.status(201).json({ class: { id, ...data, createdAt: null } });
  } catch (error) {
    return reportWriteError(response, error, 'Class');
  }
});

router.post('/departments/:departmentId/subjects', async (request, response) => {
  if (!ensureDb(response)) return;
  const departmentId = cleanText(request.params.departmentId, 128);
  const name = validName(request.body?.name);
  const code = cleanCode(request.body?.code);
  if (!departmentId || !name || !CODE_PATTERN.test(code)) {
    return response.status(400).json({ error: 'Select a department and enter a valid subject name and code.' });
  }
  try {
    const departmentSnapshot = await adminDb.collection('departments').doc(departmentId).get();
    if (!departmentSnapshot.exists || departmentSnapshot.data().universityId !== UNIVERSITY_ID) {
      return response.status(404).json({ error: 'Department not found under this university.' });
    }
    const department = departmentSnapshot.data();
    const id = recordId(departmentId, code);
    const data = {
      name,
      code,
      universityId: UNIVERSITY_ID,
      schoolId: department.schoolId,
      schoolName: department.schoolName,
      departmentId,
      departmentName: department.name,
      createdBy: request.authUser.uid,
      createdAt: FieldValue.serverTimestamp(),
    };
    await createUniqueRecord(request, 'subjects', id, data, 'subject.create', 'subject', { departmentId, code });
    return response.status(201).json({ subject: { id, ...data, createdAt: null } });
  } catch (error) {
    return reportWriteError(response, error, 'Subject');
  }
});

router.post('/users', async (request, response) => {
  if (!ensureDb(response)) return;
  if (!ensureAuthAdmin(response)) return;
  try {
    return response.status(201).json(await assignScopedRole(request, request.body));
  } catch (error) {
    if (error?.statusCode) return response.status(error.statusCode).json({ error: error.message });
    return reportWriteError(response, error, 'Role assignment');
  }
});

router.delete('/role-assignments/:uid/:assignmentId', async (request, response) => {
  if (!ensureDb(response)) return;
  const uid = cleanText(request.params.uid, 128);
  const assignmentId = cleanText(request.params.assignmentId, 180);
  if (!uid || !assignmentId || uid.includes('/') || assignmentId.includes('/')) {
    return response.status(400).json({ error: 'Invalid role assignment.' });
  }
  try {
    const userRef = adminDb.collection('users').doc(uid);
    const roleRef = userRef.collection('roles').doc(assignmentId);
    await adminDb.runTransaction(async (transaction) => {
      const roleSnapshot = await transaction.get(roleRef);
      if (!roleSnapshot.exists) {
        const missing = new Error('not-found');
        missing.code = 'not-found';
        throw missing;
      }
      transaction.delete(roleRef);
      await auditInTransaction(transaction, request, 'role.revoke', 'user', uid, { assignmentId });
    });
    return response.status(204).end();
  } catch (error) {
    if (error?.code === 'not-found') return response.status(404).json({ error: 'Role assignment not found.' });
    return reportWriteError(response, error, 'Role assignment');
  }
});

export default router;
