import React, { useEffect, useMemo, useState } from 'react';
import { supabase } from './supabase.js';
import { getAccessToken } from './apiAuth.js';
import { apiUrl } from './apiBase.js';
import './admin.css';

const roleOptions = [
  { value: 'school_admin', label: 'School admin', scope: 'schools' },
  { value: 'dean', label: 'Dean', scope: 'schools' },
  { value: 'hod', label: 'Head of department', scope: 'departments' },
  { value: 'subject_coordinator', label: 'Subject coordinator', scope: 'subjects' },
  { value: 'subject_teacher', label: 'Subject teacher', scope: 'offerings' },
  { value: 'class_teacher', label: 'Class teacher', scope: 'divisions' },
  { value: 'student', label: 'Student', scope: 'divisions' },
];

const emptyCatalog = { schools: [], departments: [], programs: [], academicYears: [], semesters: [], divisions: [], classes: [], subjects: [], offerings: [] };
const directoryCsvHeaders = ['type', 'name', 'code', 'id', 'schoolCode', 'departmentCode', 'programCode', 'intakeYear', 'graduationYear', 'yearNumber', 'semesterNumber'];
const roleCsvHeaders = ['email', 'displayName', 'role', 'scopeId'];

function encodeCsvCell(value) {
  let text = String(value ?? '');
  if (/^[\t\r\n ]*[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadCsv(filename, headers, rows) {
  const content = [headers, ...rows.map((row) => headers.map((header) => row[header] ?? ''))]
    .map((row) => row.map(encodeCsvCell).join(','))
    .join('\r\n');
  const blob = new Blob([`\uFEFF${content}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function parseCsv(source) {
  const text = source.replace(/^\uFEFF/, '');
  const table = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field);
      if (row.some((value) => value.trim())) table.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error('The CSV contains an unfinished quoted field.');
  row.push(field);
  if (row.some((value) => value.trim())) table.push(row);
  if (table.length < 2) throw new Error('The CSV needs a header and at least one data row.');
  const headers = table[0].map((header) => header.trim());
  if (headers.some((header) => !header) || new Set(headers).size !== headers.length) {
    throw new Error('The CSV headers must be present and unique.');
  }
  if (table.length - 1 > 250) throw new Error('Import up to 250 rows per CSV.');
  return table.slice(1).map((values, index) => {
    if (values.length !== headers.length) throw new Error(`CSV row ${index + 2} has a different number of columns than the header.`);
    return Object.fromEntries(headers.map((header, column) => [header, values[column]]));
  });
}

function labelFor(item) {
  return `${item.name || 'Untitled'}${item.code ? ` · ${item.code}` : ''}`;
}

function normalizeDirectoryCode(value) {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, '-')
    .replace(/[-_]{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 24)
    .replace(/[-_]+$/g, '');
}

function isStrongInitialPassword(value) {
  return value.length >= 12
    && value.length <= 128
    && /[a-z]/.test(value)
    && /[A-Z]/.test(value)
    && /\d/.test(value)
    && /[^A-Za-z0-9]/.test(value);
}

function generateTemporaryPassword() {
  const groups = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%*-_'];
  const randomIndex = (max) => {
    const value = new Uint32Array(1);
    const range = 0x100000000;
    const limit = range - (range % max);
    do { window.crypto.getRandomValues(value); } while (value[0] >= limit);
    return value[0] % max;
  };
  const characters = groups.map((group) => group[randomIndex(group.length)]);
  const allCharacters = groups.join('');
  while (characters.length < 20) characters.push(allCharacters[randomIndex(allCharacters.length)]);
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIndex(index + 1);
    [characters[index], characters[swapIndex]] = [characters[swapIndex], characters[index]];
  }
  return characters.join('');
}

function semesterLabel(item) {
  return `${item.programName || 'Program'} / ${item.academicYearName || 'Year'} / ${item.name || 'Semester'}`;
}

export default function AdminDashboard({ user, onBack }) {
  const [summary, setSummary] = useState(null);
  const [catalog, setCatalog] = useState(emptyCatalog);
  const [assignments, setAssignments] = useState([]);
  const [schoolName, setSchoolName] = useState('');
  const [schoolCode, setSchoolCode] = useState('');
  const [departmentName, setDepartmentName] = useState('');
  const [departmentCode, setDepartmentCode] = useState('');
  const [selectedSchoolId, setSelectedSchoolId] = useState('');
  const [programName, setProgramName] = useState('');
  const [programCode, setProgramCode] = useState('');
  const [programIntakeYear, setProgramIntakeYear] = useState(String(new Date().getFullYear()));
  const [programGraduationYear, setProgramGraduationYear] = useState(String(new Date().getFullYear() + 4));
  const [selectedProgramDepartmentId, setSelectedProgramDepartmentId] = useState('');
  const [divisionName, setDivisionName] = useState('');
  const [divisionCode, setDivisionCode] = useState('');
  const [selectedSemesterId, setSelectedSemesterId] = useState('');
  const [subjectName, setSubjectName] = useState('');
  const [subjectCode, setSubjectCode] = useState('');
  const [memberEmail, setMemberEmail] = useState('');
  const [memberName, setMemberName] = useState('');
  const [memberRole, setMemberRole] = useState('school_admin');
  const [memberScopeId, setMemberScopeId] = useState('');
  const [memberAccountMode, setMemberAccountMode] = useState('create');
  const [memberPassword, setMemberPassword] = useState('');
  const [showMemberPassword, setShowMemberPassword] = useState(false);
  const [memberIdentityConfirmed, setMemberIdentityConfirmed] = useState(false);
  const [bulkKind, setBulkKind] = useState('directory');
  const [bulkFileName, setBulkFileName] = useState('');
  const [bulkRows, setBulkRows] = useState([]);
  const [bulkPreview, setBulkPreview] = useState(null);
  const [bulkOutcome, setBulkOutcome] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const currentRole = roleOptions.find((role) => role.value === memberRole) || roleOptions[0];
  const scopeItems = useMemo(() => catalog[currentRole.scope] || [], [catalog, currentRole.scope]);

  async function apiRequest(path, options = {}) {
    const token = await getAccessToken();
    const response = await fetch(apiUrl(path), {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    });
    if (response.status === 204) return {};
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'The admin request could not be completed.');
    return result;
  }

  async function loadDashboard() {
    setLoading(true);
    setError('');
    try {
      const [dashboard, directory, roleData] = await Promise.all([
        apiRequest('/api/admin/dashboard'),
        apiRequest('/api/admin/catalog'),
        apiRequest('/api/admin/role-assignments'),
      ]);
      setSummary(dashboard);
      setCatalog(directory);
      setAssignments(roleData.assignments || []);
      setSelectedSchoolId((current) => current || directory.schools[0]?.id || '');
      setSelectedProgramDepartmentId((current) => current || directory.departments[0]?.id || '');
      setSelectedSemesterId((current) => current || directory.semesters[0]?.id || '');
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadDashboard(); }, [user]);

  async function perform(key, endpoint, body, successMessage, method = 'POST') {
    setBusy(key);
    setError('');
    setNotice('');
    try {
      const result = await apiRequest(endpoint, {
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      await loadDashboard();
      setNotice(typeof successMessage === 'function' ? successMessage(result) : successMessage);
      return result || true;
    } catch (requestError) {
      setError(requestError.message);
      return false;
    } finally {
      setBusy('');
    }
  }

  async function submitSchool(event) {
    event.preventDefault();
    if (await perform('school', '/api/admin/schools', { name: schoolName, code: schoolCode }, 'School registered under MIT ADT University.')) {
      setSchoolName('');
      setSchoolCode('');
    }
  }

  async function submitDepartment(event) {
    event.preventDefault();
    if (!selectedSchoolId) return setError('Register a school before adding departments.');
    const normalizedCode = normalizeDirectoryCode(departmentCode);
    setDepartmentCode(normalizedCode);
    if (normalizedCode.length < 2 || !/^[A-Z0-9][A-Z0-9_-]{1,23}$/.test(normalizedCode)) {
      return setError('Use a department code with 2–24 letters or numbers. Hyphens and underscores are allowed.');
    }
    if (await perform('department', `/api/admin/schools/${encodeURIComponent(selectedSchoolId)}/departments`, { name: departmentName, code: normalizedCode }, 'Department added to the selected school.')) {
      setDepartmentName('');
      setDepartmentCode('');
    }
  }

  async function submitProgram(event) {
    event.preventDefault();
    if (!selectedProgramDepartmentId) return setError('Add a department before registering a program.');
    const result = await perform(
      'program',
      `/api/admin/departments/${encodeURIComponent(selectedProgramDepartmentId)}/programs`,
      { name: programName, code: programCode, intakeYear: Number(programIntakeYear), graduationYear: Number(programGraduationYear) },
      'Program registered with academic years and semesters.',
    );
    if (result) {
      setProgramName('');
      setProgramCode('');
      if (result.program?.firstSemesterId) setSelectedSemesterId(result.program.firstSemesterId);
    }
  }

  async function submitDivision(event) {
    event.preventDefault();
    if (!selectedSemesterId) return setError('Register a program before creating divisions.');
    const ok = await perform(
      'division',
      `/api/admin/semesters/${encodeURIComponent(selectedSemesterId)}/divisions`,
      { name: divisionName, code: divisionCode },
      'Division added. Its subject offerings are linked automatically.',
    );
    if (ok) {
      setDivisionName('');
      setDivisionCode('');
    }
  }

  async function submitSubject(event) {
    event.preventDefault();
    if (!selectedSemesterId) return setError('Register a program before adding semester subjects.');
    const ok = await perform(
      'subject',
      `/api/admin/semesters/${encodeURIComponent(selectedSemesterId)}/subjects`,
      { name: subjectName, code: subjectCode },
      'Subject added to the semester and linked to its divisions.',
    );
    if (ok) {
      setSubjectName('');
      setSubjectCode('');
    }
  }

  async function submitMember(event) {
    event.preventDefault();
    if (memberName.trim().replace(/\s+/g, ' ').length < 2) return setError('Enter the person’s full name.');
    if (!/^\S+@\S+\.\S+$/.test(memberEmail.trim())) return setError('Enter a valid email address.');
    if (!memberScopeId) return setError('Choose a school, department, subject, subject offering, or division for this role.');
    const createAccount = memberAccountMode === 'create';
    if (createAccount && !memberIdentityConfirmed) return setError('Confirm that the person is authorized to use this email before creating the account.');
    if (createAccount && !isStrongInitialPassword(memberPassword)) {
      return setError('Use a unique 12–128 character password with uppercase and lowercase letters, a number, and a symbol.');
    }
    const result = await perform(
      'member',
      '/api/admin/users',
      {
        email: memberEmail.trim().toLowerCase(),
        displayName: memberName,
        role: memberRole,
        scopeId: memberScopeId,
        createAccount,
        ...(createAccount ? { password: memberPassword, identityConfirmed: memberIdentityConfirmed } : {}),
      },
      (saved) => saved.accountCreated
        ? 'Account created and email confirmed. The user must change the temporary password after signing in.'
        : 'Role assigned to the existing account. Its password and email-confirmation status were left unchanged.',
    );
    if (result) {
      setMemberEmail('');
      setMemberName('');
      setMemberScopeId('');
      setMemberPassword('');
      setShowMemberPassword(false);
      setMemberIdentityConfirmed(false);
    }
  }

  async function removeRole(assignment) {
    if (!window.confirm(`Remove ${assignment.roleLabel || assignment.role} from ${assignment.email || 'this user'}?`)) return;
    await perform(
      `remove:${assignment.id}`,
      `/api/admin/role-assignments/${encodeURIComponent(assignment.uid)}/${encodeURIComponent(assignment.id)}`,
      undefined,
      'Role assignment removed.',
      'DELETE',
    );
  }

  function downloadTemplate() {
    downloadCsv(
      bulkKind === 'directory' ? 'mit-adt-directory-template.csv' : 'mit-adt-role-assignments-template.csv',
      bulkKind === 'directory' ? directoryCsvHeaders : roleCsvHeaders,
      [],
    );
  }

  function downloadDirectoryExport() {
    const schoolsById = new Map(catalog.schools.map((item) => [item.id, item]));
    const departmentsById = new Map(catalog.departments.map((item) => [item.id, item]));
    const programsById = new Map(catalog.programs.map((item) => [item.id, item]));
    const rows = [
      ...catalog.schools.map((item) => ({ type: 'school', name: item.name, code: item.code, id: item.id })),
      ...catalog.departments.map((item) => ({
        type: 'department', name: item.name, code: item.code, id: item.id,
        schoolCode: schoolsById.get(item.schoolId)?.code || '',
      })),
      ...catalog.programs.map((item) => ({
        type: 'program', name: item.name, code: item.code, id: item.id,
        schoolCode: schoolsById.get(item.schoolId)?.code || '',
        departmentCode: departmentsById.get(item.departmentId)?.code || '',
        intakeYear: item.intakeYear,
        graduationYear: item.graduationYear,
      })),
      ...catalog.divisions.map((item) => ({
        type: 'division', name: item.name, code: item.code, id: item.id,
        schoolCode: schoolsById.get(item.schoolId)?.code || '',
        departmentCode: departmentsById.get(item.departmentId)?.code || '',
        programCode: programsById.get(item.programId)?.code || '',
        yearNumber: item.yearNumber,
        semesterNumber: item.semesterNumber,
      })),
      ...catalog.subjects.map((item) => ({
        type: 'subject', name: item.name, code: item.code, id: item.id,
        schoolCode: schoolsById.get(item.schoolId)?.code || '',
        departmentCode: departmentsById.get(item.departmentId)?.code || '',
        programCode: programsById.get(item.programId)?.code || '',
        yearNumber: item.yearNumber,
        semesterNumber: item.semesterNumber,
      })),
      ...catalog.offerings.map((item) => ({
        type: 'offering', name: item.name, code: item.code, id: item.id,
        schoolCode: schoolsById.get(item.schoolId)?.code || '',
        departmentCode: departmentsById.get(item.departmentId)?.code || '',
        programCode: programsById.get(item.programId)?.code || '',
        yearNumber: item.yearNumber,
        semesterNumber: item.semesterNumber,
      })),
    ];
    downloadCsv('mit-adt-directory-export.csv', directoryCsvHeaders, rows);
  }

  function downloadRoleExport() {
    downloadCsv('mit-adt-role-assignments-export.csv', roleCsvHeaders, assignments.map((item) => ({
      email: item.email || '',
      displayName: item.displayName || '',
      role: item.role || '',
      scopeId: item.scopeId || '',
    })));
  }

  async function handleCsvFile(event) {
    const file = event.target.files?.[0];
    setBulkFileName(file?.name || '');
    setBulkRows([]);
    setBulkPreview(null);
    setBulkOutcome(null);
    if (!file) return;
    setError('');
    setNotice('');
    if (file.size > 1024 * 1024) return setError('CSV files must be 1 MB or smaller.');
    try {
      const rows = parseCsv(await file.text());
      const headers = new Set(Object.keys(rows[0] || {}));
      const required = bulkKind === 'directory'
        ? ['type', 'name', 'code', 'schoolCode', 'departmentCode', 'programCode', 'intakeYear', 'graduationYear', 'yearNumber', 'semesterNumber']
        : ['email', 'displayName', 'role', 'scopeId'];
      const missing = required.filter((header) => !headers.has(header));
      if (missing.length) throw new Error(`Missing CSV columns: ${missing.join(', ')}.`);
      setBulkRows(rows);
      setNotice(`Loaded ${rows.length} rows from ${file.name}. Preview them before importing.`);
    } catch (fileError) {
      setError(fileError.message || 'Could not read this CSV file.');
    }
  }

  async function previewBulkImport() {
    setBusy('preview');
    setError('');
    setNotice('');
    setBulkOutcome(null);
    try {
      const preview = await apiRequest('/api/admin/import/preview', {
        method: 'POST',
        body: JSON.stringify({ kind: bulkKind, rows: bulkRows }),
      });
      setBulkPreview(preview);
      const invalid = preview.results.filter((item) => !item.ok).length;
      setNotice(invalid ? `${invalid} row${invalid === 1 ? '' : 's'} need attention before import.` : `${preview.rowCount} rows passed validation and are ready to import.`);
    } catch (previewError) {
      setError(previewError.message);
    } finally {
      setBusy('');
    }
  }

  async function commitBulkImport() {
    if (!bulkPreview?.valid || !bulkRows.length) return;
    setBusy('import');
    setError('');
    setNotice('');
    try {
      const outcome = await apiRequest('/api/admin/import', {
        method: 'POST',
        body: JSON.stringify({ kind: bulkKind, rows: bulkRows }),
      });
      setBulkOutcome(outcome);
      setNotice(`Imported ${outcome.succeeded} row${outcome.succeeded === 1 ? '' : 's'}${outcome.failed ? `; ${outcome.failed} failed` : ''}.`);
      await loadDashboard();
    } catch (importError) {
      setError(importError.message);
    } finally {
      setBusy('');
    }
  }

  async function handleSignOut() {
    if (supabase) await supabase.auth.signOut();
    onBack();
  }

  return (
    <main className="admin-page">
      <div className="admin-shell">
        <div className="admin-topbar">
          <div className="admin-mark"><span className="admin-mark-icon">M</span><span><strong>MIT ADT LMS</strong><small>Platform administration</small></span></div>
          <div className="admin-account"><span>{user.displayName || user.email}</span><button type="button" onClick={handleSignOut}>Sign out</button></div>
        </div>

        <section className="admin-heading">
          <div>
            <p className="section-kicker">University workspace</p>
            <h1>Admin dashboard</h1>
            <p>Manage schools, departments, programs, academic years, semesters, divisions, subjects, and role assignments.</p>
          </div>
          <button className="admin-back" type="button" onClick={onBack}>← Back to landing page</button>
        </section>

        {error && <div className="admin-alert error" role="alert">{error}</div>}
        {notice && <div className="admin-alert success" role="status">{notice}</div>}

        {loading ? <div className="admin-loading">Loading the university directory…</div> : (
          <>
            {summary && <section className="admin-stats" aria-label="University totals">
              <div className="admin-stat"><span>Schools</span><strong>{summary.counts.schools}</strong></div>
              <div className="admin-stat"><span>Departments</span><strong>{summary.counts.departments}</strong></div>
              <div className="admin-stat"><span>Programs</span><strong>{summary.counts.programs}</strong></div>
              <div className="admin-stat"><span>Academic years</span><strong>{summary.counts.academicYears}</strong></div>
              <div className="admin-stat"><span>Semesters</span><strong>{summary.counts.semesters}</strong></div>
              <div className="admin-stat"><span>Divisions</span><strong>{summary.counts.divisions}</strong></div>
              <div className="admin-stat"><span>Subjects</span><strong>{summary.counts.subjects}</strong></div>
              <div className="admin-stat"><span>Subject offerings</span><strong>{summary.counts.offerings}</strong></div>
              <div className="admin-stat"><span>Accounts</span><strong>{summary.counts.users}</strong></div>
            </section>}

            <section className="admin-forms" aria-label="Create university structure">
              <form className="admin-card" onSubmit={submitSchool}>
                <div className="admin-card-heading"><span>01</span><div><h2>Register a school</h2><p>Attach a school to {summary?.university.name || 'MIT ADT University'}.</p></div></div>
                <label>School name<input value={schoolName} onChange={(event) => setSchoolName(event.target.value)} maxLength={100} required placeholder="e.g. School of Computing" /></label>
                <label>School code<input value={schoolCode} onChange={(event) => setSchoolCode(event.target.value)} maxLength={24} required placeholder="e.g. SOC" /></label>
                <button className="admin-submit" disabled={busy === 'school'}>{busy === 'school' ? 'Saving…' : 'Register school'}</button>
              </form>

              <form className="admin-card" onSubmit={submitDepartment}>
                <div className="admin-card-heading"><span>02</span><div><h2>Add a department</h2><p>Departments belong to one registered school.</p></div></div>
                <label>School<select value={selectedSchoolId} onChange={(event) => setSelectedSchoolId(event.target.value)} required><option value="">Choose a school</option>{catalog.schools.map((item) => <option key={item.id} value={item.id}>{labelFor(item)}</option>)}</select></label>
                <label>Department name<input value={departmentName} onChange={(event) => setDepartmentName(event.target.value)} maxLength={100} required placeholder="e.g. Computer Science" /></label>
                <label>Department code<input value={normalizeDirectoryCode(departmentCode)} onChange={(event) => setDepartmentCode(normalizeDirectoryCode(event.target.value))} maxLength={24} pattern="[A-Za-z0-9][A-Za-z0-9_-]{1,23}" title="Use 2–24 letters or numbers; hyphens and underscores are allowed." required placeholder="e.g. CSE" /><small>Spaces become hyphens; letters and numbers, hyphens, and underscores are allowed.</small></label>
                <button className="admin-submit" disabled={busy === 'department' || !catalog.schools.length}>{busy === 'department' ? 'Saving…' : 'Add department'}</button>
              </form>

              <form className="admin-card" onSubmit={submitProgram}>
                <div className="admin-card-heading"><span>03</span><div><h2>Register a program</h2><p>Choose an intake and graduation year. The two-semester academic years are generated automatically.</p></div></div>
                <label>Department<select value={selectedProgramDepartmentId} onChange={(event) => setSelectedProgramDepartmentId(event.target.value)} required><option value="">Choose a department</option>{catalog.departments.map((item) => <option key={item.id} value={item.id}>{item.schoolName} / {labelFor(item)}</option>)}</select></label>
                <label>Program name<input value={programName} onChange={(event) => setProgramName(event.target.value)} maxLength={100} required placeholder="e.g. B.Tech Computer Science" /></label>
                <label>Program code<input value={programCode} onChange={(event) => setProgramCode(event.target.value)} maxLength={24} required placeholder="e.g. BTECHCSE" /></label>
                <div className="admin-inline-fields"><label>Intake year<input type="number" min="2000" max="2100" value={programIntakeYear} onChange={(event) => setProgramIntakeYear(event.target.value)} required /></label><label>Graduation year<input type="number" min="2001" max="2100" value={programGraduationYear} onChange={(event) => setProgramGraduationYear(event.target.value)} required /></label></div>
                <p className="admin-form-note">Example: 2024 to 2028 creates FY, SY, TY, LY, each with Semester 1 and Semester 2.</p>
                <button className="admin-submit" disabled={busy === 'program' || !catalog.departments.length}>{busy === 'program' ? 'Saving…' : 'Register program'}</button>
              </form>

              <form className="admin-card" onSubmit={submitDivision}>
                <div className="admin-card-heading"><span>04</span><div><h2>Add a division</h2><p>Divisions belong to a program semester. Subject offerings are generated automatically.</p></div></div>
                <label>Program semester<select value={selectedSemesterId} onChange={(event) => setSelectedSemesterId(event.target.value)} required><option value="">Choose a semester</option>{catalog.semesters.map((item) => <option key={item.id} value={item.id}>{semesterLabel(item)}</option>)}</select></label>
                <label>Division name<input value={divisionName} onChange={(event) => setDivisionName(event.target.value)} maxLength={100} required placeholder="e.g. Division A" /></label>
                <label>Division code<input value={divisionCode} onChange={(event) => setDivisionCode(event.target.value)} maxLength={8} required placeholder="e.g. A" /></label>
                <button className="admin-submit" disabled={busy === 'division' || !catalog.semesters.length}>{busy === 'division' ? 'Saving…' : 'Add division'}</button>
              </form>

              <form className="admin-card" onSubmit={submitSubject}>
                <div className="admin-card-heading"><span>05</span><div><h2>Add a subject</h2><p>Subjects belong to a semester and are offered to each division in it.</p></div></div>
                <label>Program semester<select value={selectedSemesterId} onChange={(event) => setSelectedSemesterId(event.target.value)} required><option value="">Choose a semester</option>{catalog.semesters.map((item) => <option key={item.id} value={item.id}>{semesterLabel(item)}</option>)}</select></label>
                <label>Subject name<input value={subjectName} onChange={(event) => setSubjectName(event.target.value)} maxLength={100} required placeholder="e.g. Data Structures" /></label>
                <label>Subject code<input value={subjectCode} onChange={(event) => setSubjectCode(event.target.value)} maxLength={24} required placeholder="e.g. CS201" /></label>
                <button className="admin-submit" disabled={busy === 'subject' || !catalog.semesters.length}>{busy === 'subject' ? 'Saving…' : 'Add subject'}</button>
              </form>
            </section>

            <section className="admin-bulk-panel" aria-labelledby="admin-bulk-title">
              <div className="admin-bulk-heading">
                <div><p className="section-kicker">CSV tools</p><h2 id="admin-bulk-title">Bulk import and export</h2></div>
                <p>Download a template, preview up to 250 rows, then import. Each imported row is validated and recorded in the audit log.</p>
              </div>
              <div className="admin-bulk-actions">
                <button type="button" onClick={downloadTemplate}>Download {bulkKind === 'directory' ? 'directory' : 'role'} template</button>
                <button type="button" onClick={downloadDirectoryExport} disabled={loading}>Export directory CSV</button>
                <button type="button" onClick={downloadRoleExport} disabled={loading}>Export role assignments CSV</button>
              </div>
              <div className="admin-bulk-import">
                <label>Import type<select value={bulkKind} onChange={(event) => {
                  setBulkKind(event.target.value);
                  setBulkFileName('');
                  setBulkRows([]);
                  setBulkPreview(null);
                  setBulkOutcome(null);
                }}><option value="directory">Schools, departments, programs, divisions, subjects</option><option value="roles">Accounts and role assignments</option></select></label>
                <label>CSV file<input key={bulkKind} type="file" accept=".csv,text/csv" onChange={handleCsvFile} /></label>
                <span className="admin-bulk-file">{bulkFileName || 'No file selected'}</span>
                <button type="button" onClick={previewBulkImport} disabled={!bulkRows.length || Boolean(busy)}>{busy === 'preview' ? 'Checking rows…' : 'Preview import'}</button>
                <button type="button" className="admin-bulk-primary" onClick={commitBulkImport} disabled={!bulkPreview?.valid || Boolean(busy)}>{busy === 'import' ? 'Importing…' : `Import ${bulkPreview?.rowCount || 0} rows`}</button>
              </div>
              <p className="admin-bulk-note">Directory columns: <code>type, name, code, schoolCode, departmentCode, programCode, intakeYear, graduationYear, yearNumber, semesterNumber</code>. Use school → department → program rows first; then division and subject rows reference the program, year, and semester. Role columns: <code>email, displayName, role, scopeId</code>; teachers are assigned to a subject offering and coordinators to a subject. The directory export also lists generated offering IDs for teacher assignments. CSV files are limited to 250 rows and 1 MB; exports show up to 500 records per collection. Role exports contain personal email addresses. Imports save row by row, so review any failures before retrying. Role CSV imports assign existing accounts; create new accounts individually with a temporary password.</p>
              {bulkPreview && <div className={`admin-bulk-results ${bulkPreview.valid ? 'is-valid' : 'has-errors'}`} role="status">
                <strong>{bulkPreview.valid ? `${bulkPreview.rowCount} rows ready` : 'Fix these rows before importing'}</strong>
                <ul>{bulkPreview.results.slice(0, 30).map((item) => <li key={item.row}><span>Row {item.row}: {item.summary || item.error}</span><b>{item.ok ? 'Ready' : 'Needs fix'}</b></li>)}</ul>
                {bulkPreview.results.length > 30 && <small>Showing the first 30 rows.</small>}
              </div>}
              {bulkOutcome && <div className="admin-bulk-results" role="status">
                <strong>{bulkOutcome.succeeded} imported · {bulkOutcome.failed} failed</strong>
                {bulkOutcome.results.some((item) => !item.ok) && <ul>{bulkOutcome.results.filter((item) => !item.ok).slice(0, 30).map((item) => <li key={item.row}><span>Row {item.row}: {item.error}</span><b>Failed</b></li>)}</ul>}
              </div>}
            </section>

            <section className="admin-lower-grid">
              <form className="admin-card role-card" noValidate onSubmit={submitMember}>
                <div className="admin-card-heading"><span>06</span><div><h2>Create an account and assign a role</h2><p>Roles are stored on the server with school, department, subject, offering, or division scope.</p></div></div>
                {summary && !summary.accountProvisioningConfigured && <p className="admin-config-warning" role="status">Account setup is unavailable. Add the Supabase Auth Admin secret as <code>SUPABASE_SECRET_KEY</code> to the server environment; never put it in the browser.</p>}
                <label>Full name<input value={memberName} onChange={(event) => setMemberName(event.target.value)} maxLength={80} required placeholder="Person’s name" /></label>
                <label>Email address<input type="email" value={memberEmail} onChange={(event) => setMemberEmail(event.target.value)} maxLength={254} required placeholder="name@university.edu" /></label>
                <label>Account action<select value={memberAccountMode} onChange={(event) => { setMemberAccountMode(event.target.value); setMemberPassword(''); setShowMemberPassword(false); setMemberIdentityConfirmed(false); }}><option value="create">Create a new account</option><option value="existing">Assign a role to an existing account</option></select></label>
                {memberAccountMode === 'create' && <>
                  <label>Temporary password<div className="admin-password-control"><input type={showMemberPassword ? 'text' : 'password'} autoComplete="new-password" value={memberPassword} onChange={(event) => { setMemberPassword(event.target.value); setError(''); }} minLength={12} maxLength={128} required placeholder="Create a unique temporary password" /><div className="admin-password-actions"><button type="button" onClick={() => { if (!window.crypto?.getRandomValues) return setError('Secure password generation is unavailable in this browser. Enter a strong password manually.'); setMemberPassword(generateTemporaryPassword()); setShowMemberPassword(true); setError(''); }}>Generate secure password</button><button type="button" onClick={() => setShowMemberPassword((shown) => !shown)}>{showMemberPassword ? 'Hide' : 'Show'}</button></div></div></label>
                  <p className="admin-form-note">Use 12–128 characters with uppercase and lowercase letters, a number, and a symbol. The user must change it at first sign-in.</p>
                  <label className="admin-attestation"><input type="checkbox" checked={memberIdentityConfirmed} onChange={(event) => { setMemberIdentityConfirmed(event.target.checked); setError(''); }} required /><span>I verified this person is authorized to use this email. Admin-created accounts are confirmed without an email link.</span></label>
                </>}
                <div className="admin-inline-fields"><label>Role<select value={memberRole} onChange={(event) => { setMemberRole(event.target.value); setMemberScopeId(''); }}>
                  {roleOptions.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}
                </select></label><label>Scope<select value={memberScopeId} onChange={(event) => setMemberScopeId(event.target.value)} required><option value="">Choose scope</option>{scopeItems.map((item) => <option key={item.id} value={item.id}>{labelFor(item)}</option>)}</select></label></div>
                <button className="admin-submit" disabled={busy === 'member' || !scopeItems.length || !summary?.accountProvisioningConfigured}>{busy === 'member' ? 'Saving…' : memberAccountMode === 'create' ? 'Create account + assign role' : 'Assign role to existing account'}</button>
                <p className="admin-form-note">Passwords are sent only to Supabase Auth and are never stored in LMS records. Use real addresses; existing accounts keep their current password and verification state.</p>
              </form>

              <section className="admin-card roles-list-card">
                <div className="admin-card-heading"><span>07</span><div><h2>Role assignments</h2><p>Remove access when someone changes responsibilities.</p></div></div>
                {assignments.length ? <div className="role-table-wrap"><table className="role-table"><thead><tr><th>Person</th><th>Role</th><th>Scope</th><th /></tr></thead><tbody>
                  {assignments.map((assignment) => <tr key={`${assignment.uid}:${assignment.id}`}>
                    <td><strong>{assignment.displayName || assignment.email}</strong><small>{assignment.email}</small><small>{assignment.pending ? 'Invited · awaiting account registration' : assignment.emailVerified ? 'Email verified' : 'Email not verified'}</small></td>
                    <td>{assignment.roleLabel || assignment.role}</td>
                    <td>{assignment.scopeName || assignment.scopeType}</td>
                    <td><button className="role-remove" type="button" disabled={busy === `remove:${assignment.id}`} onClick={() => removeRole(assignment)}>Remove</button></td>
                  </tr>)}
                </tbody></table></div> : <p className="admin-empty">No scoped roles have been assigned yet.</p>}
              </section>
            </section>

            <section className="admin-school-list">
              <div><p className="section-kicker">Directory</p><h2>Academic hierarchy</h2><p className="admin-directory-intro">Programs generate academic years and two semesters per year. Every division and subject is managed at semester level.</p></div>
              {catalog.schools.length ? <div className="hierarchy-tree">{catalog.schools.map((school) => {
                const departments = catalog.departments.filter((item) => item.schoolId === school.id);
                return <details className="hierarchy-school" key={school.id} open>
                  <summary><span className="hierarchy-type">School</span><strong>{school.name}</strong><code>{school.code}</code></summary>
                  <div className="hierarchy-level">{departments.map((department) => {
                    const programs = catalog.programs.filter((item) => item.departmentId === department.id);
                    return <details className="hierarchy-department" key={department.id}>
                      <summary><span className="hierarchy-type">Department</span><strong>{department.name}</strong><code>{department.code}</code></summary>
                      <div className="hierarchy-level">{programs.map((program) => {
                        const academicYears = catalog.academicYears.filter((item) => item.programId === program.id).sort((a, b) => a.yearNumber - b.yearNumber);
                        return <details className="hierarchy-program" key={program.id}>
                          <summary><span className="hierarchy-type">Program</span><strong>{program.name}</strong><code>{program.code} · {program.intakeYear}-{program.graduationYear}</code></summary>
                          <div className="hierarchy-level">{academicYears.map((academicYear) => {
                            const semesters = catalog.semesters.filter((item) => item.academicYearId === academicYear.id).sort((a, b) => a.semesterNumber - b.semesterNumber);
                            return <details className="hierarchy-year" key={academicYear.id}>
                              <summary><span className="hierarchy-type">Year {academicYear.yearNumber}</span><strong>{academicYear.label}</strong><span>{academicYear.startYear}-{academicYear.endYear}</span></summary>
                              <div className="hierarchy-level">{semesters.map((semester) => {
                                const divisions = catalog.divisions.filter((item) => item.semesterId === semester.id);
                                const subjects = catalog.subjects.filter((item) => item.semesterId === semester.id);
                                return <details className="hierarchy-semester" key={semester.id}>
                                  <summary><span className="hierarchy-type">Semester {semester.semesterNumber}</span><strong>{divisions.length} division{divisions.length === 1 ? '' : 's'} · {subjects.length} subject{subjects.length === 1 ? '' : 's'}</strong></summary>
                                  <div className="semester-content">
                                    <div className="semester-subjects"><h4>Subjects</h4>{subjects.length ? <ul>{subjects.map((subject) => {
                                      const coordinator = assignments.find((item) => item.role === 'subject_coordinator' && item.scopeId === subject.id);
                                      return <li key={subject.id}><span><strong>{subject.name}</strong><small>{subject.code}{coordinator ? ` · Coordinator: ${coordinator.displayName || coordinator.email}` : ''}</small></span></li>;
                                    })}</ul> : <p>No subjects registered.</p>}</div>
                                    <div className="semester-divisions"><h4>Divisions and teaching assignments</h4>{divisions.length ? divisions.map((division) => {
                                      const offerings = catalog.offerings.filter((item) => item.divisionId === division.id);
                                      const classTeacher = assignments.find((item) => item.role === 'class_teacher' && item.scopeId === division.id);
                                      return <div className="division-card" key={division.id}>
                                        <div className="division-heading"><strong>{division.name}</strong><code>{division.code}</code>{classTeacher && <span>Class teacher: {classTeacher.displayName || classTeacher.email}</span>}</div>
                                        {offerings.length ? <ul>{offerings.map((offering) => {
                                          const teacher = assignments.find((item) => item.role === 'subject_teacher' && item.scopeId === offering.id);
                                          return <li key={offering.id}><span>{offering.subjectName} <small>{offering.subjectCode}</small></span><span className="offering-teacher">{teacher ? teacher.displayName || teacher.email : 'Teacher not assigned'}</span></li>;
                                        })}</ul> : <p>No subject offerings yet.</p>}
                                      </div>;
                                    }) : <p>No divisions registered.</p>}</div>
                                  </div>
                                </details>;
                              })}</div>
                            </details>;
                          })}</div>
                        </details>;
                      })}</div>
                    </details>;
                  })}</div>
                </details>;
              })}</div> : <p className="admin-empty">No schools registered yet. Add the first school above.</p>}
            </section>
          </>
        )}

        <footer className="admin-footer"><span>MIT ADT LMS · Administrative access is recorded in the server audit log.</span><span>Only platform administrators can change university structure.</span></footer>
      </div>
    </main>
  );
}
