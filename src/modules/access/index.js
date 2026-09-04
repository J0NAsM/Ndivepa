/**
 * Acceso: usuarios, roles, invitaciones, claves de API, sesiones y autenticación
 * (M-0240 … M-0263).
 *
 * Sustituye el `sessions = new Map()` del monolito, que se vaciaba en cada reinicio
 * y no escalaba a más de un proceso. El hash de contraseña se mantiene compatible
 * (scrypt con `salt` y `passwordHash` en hexadecimal) para no invalidar la cuenta
 * existente al migrar.
 */
import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { BaseService, crudRoutes, defineResource } from '../base.js';
import { rule, validate } from '../../framework/validate.js';
import { ConflictError, ForbiddenError, UnauthorizedError, ValidationError } from '../../framework/errors.js';
import { DEFAULT_ROLES } from '../../framework/rbac.js';
import { token as generateToken } from '../../framework/ids.js';
import { mask, safeEqual } from '../../framework/strings.js';
import { now, plusMinutes, toDate } from '../../framework/dates.js';
import * as respond from '../../framework/http/respond.js';
import { issueCsrfToken } from '../../framework/http/middlewares.js';

/** La verificación en dos pasos se puede desactivar por instalación (`FEATURE_2FA`). */
function assertTwoFactorEnabled(container) {
  if (container.resolve('config').features.twoFactor) return true;
  throw new ConflictError('La verificación en dos pasos está desactivada en esta instalación.', { feature: 'twoFactor' });
}

/** Compatible con el monolito: mismos parámetros, mismo formato hexadecimal. */
export const hashPassword = (password, salt, cost = 16_384) => scryptSync(password, salt, 64, {
  N: cost,
  r: 8,
  p: 1,
  maxmem: Math.max(32 * 1024 * 1024, cost * 128 * 8 * 2),
}).toString('hex');

export function verifyPassword(password, salt, expectedHex, cost = 16_384) {
  const expected = Buffer.from(String(expectedHex || ''), 'hex');
  const actual = Buffer.from(hashPassword(String(password ?? ''), salt || 'invalid-salt', cost), 'hex');
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

/** Contraseñas prohibidas por obvias. La lista corta cubre el 90 % de los intentos. */
const COMMON_PASSWORDS = new Set([
  'password', 'contrasena', 'contraseña', '123456789012', 'administrador', 'qwertyuiop12',
  'ndivepa123456', 'password1234', 'admin1234567', '111111111111', 'abcdefghijkl',
]);

export function assertPasswordPolicy(password, { minLength = 12 } = {}) {
  const value = String(password ?? '');
  const issues = [];
  if (value.length < minLength) issues.push({ field: 'password', message: `Debe tener al menos ${minLength} caracteres.` });
  if (COMMON_PASSWORDS.has(value.toLowerCase())) issues.push({ field: 'password', message: 'Esa contraseña es demasiado común.' });
  if (/^(.)\1+$/.test(value)) issues.push({ field: 'password', message: 'No puede ser un único carácter repetido.' });
  if (!/[a-zA-Z]/.test(value) || !/[0-9]/.test(value)) {
    issues.push({ field: 'password', message: 'Debe combinar al menos letras y números.' });
  }
  if (issues.length) throw new ValidationError(issues);
  return true;
}

export const roleResource = defineResource({
  name: 'role',
  collection: 'roles',
  prefix: 'role',
  route: 'roles',
  unique: ['code'],
  searchable: ['name', 'code'],
  fields: {
    code: rule.handle({ required: true }),
    name: rule.text(100, { required: true }),
    description: rule.text(300),
    permissions: rule.list({ type: 'string' }, { default: [] }),
    inherits: rule.list({ type: 'string' }, { default: [] }),
    channelScope: rule.list({ type: 'string' }, { default: [] }),
    protected: rule.flag({ default: false }),
    metadata: rule.metadata(),
  },
});

export const userResource = defineResource({
  name: 'user',
  collection: 'users',
  prefix: 'usr',
  route: 'users',
  unique: ['email'],
  searchable: ['name', 'email'],
  fields: {
    name: rule.text(120, { required: true }),
    email: rule.email({ required: true }),
    // `role` se conserva por compatibilidad con la v0.1; `roleCodes` es el modelo nuevo.
    role: rule.enumOf(['admin', 'staff'], { default: 'staff' }),
    roleCodes: rule.list({ type: 'string' }, { default: [] }),
    channelScope: rule.list({ type: 'string' }, { default: [] }),
    locale: rule.text(10, { default: 'es' }),
    status: rule.enumOf(['active', 'invited', 'suspended'], { default: 'active' }),
    metadata: rule.metadata(),
  },
});

export const inviteResource = defineResource({
  name: 'invite',
  collection: 'invites',
  prefix: 'invite',
  route: 'invites',
  searchable: ['email'],
  fields: {
    email: rule.email({ required: true }),
    roleCodes: rule.list({ type: 'string' }, { default: ['support'] }),
    channelScope: rule.list({ type: 'string' }, { default: [] }),
    expiresAt: rule.date(),
    metadata: rule.metadata(),
  },
});

export const apiKeyResource = defineResource({
  name: 'apiKey',
  collection: 'apiKeys',
  prefix: 'apik',
  route: 'api-keys',
  searchable: ['name', 'prefix'],
  fields: {
    name: rule.text(120, { required: true }),
    type: rule.enumOf(['secret', 'publishable'], { default: 'secret' }),
    permissions: rule.list({ type: 'string' }, { default: [] }),
    channelScope: rule.list({ type: 'string' }, { default: [] }),
    expiresAt: rule.date(),
    metadata: rule.metadata(),
  },
});

export class RoleService extends BaseService {
  constructor(deps) {
    super(deps, roleResource);
    this.permissions = deps.permissions;
  }

  async beforeCreate(data) {
    this.assertKnownPermissions(data.permissions);
    return data;
  }

  async beforeUpdate(existing, changes) {
    if (existing.protected && changes.permissions) {
      throw new ForbiddenError('El rol de superadministración no admite cambios de permisos.');
    }
    if (changes.permissions) this.assertKnownPermissions(changes.permissions);
    return changes;
  }

  async beforeDelete(record) {
    if (record.protected) throw new ForbiddenError('Este rol está protegido y no se puede borrar.');
    const inUse = this.store.collection('users').filter(user => (user.roleCodes || []).includes(record.code));
    if (inUse.length) {
      throw new ConflictError(`El rol "${record.code}" está asignado a ${inUse.length} usuario(s).`, { users: inUse.length });
    }
  }

  assertKnownPermissions(list = []) {
    const unknown = list.filter(permission => !this.permissions.exists(permission));
    if (unknown.length) {
      throw ValidationError.single('permissions', `Permisos no reconocidos: ${unknown.join(', ')}.`);
    }
  }

  byCode(code) {
    return this.repository.find({ code });
  }
}

export class UserService extends BaseService {
  constructor(deps) {
    super(deps, userResource);
    this.roles = deps.roles;
    this.rbac = deps.rbac;
    this.config = deps.config;
  }

  /** Nunca se devuelven `salt` ni `passwordHash`, ni siquiera al superadministrador. */
  publicView(user) {
    if (!user) return null;
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      roleCodes: user.roleCodes || [],
      channelScope: user.channelScope || [],
      locale: user.locale || 'es',
      status: user.status || 'active',
      twoFactorEnabled: Boolean(user.twoFactor?.enabled),
      lastLoginAt: user.lastLoginAt || null,
      createdAt: user.createdAt,
    };
  }

  byEmail(email) {
    const normalized = String(email || '').trim().toLowerCase();
    return this.store.collection('users').find(user => String(user.email || '').toLowerCase() === normalized) || null;
  }

  /** Actor con permisos ya expandidos, listo para el pipeline. */
  toActor(user) {
    if (!user) return null;
    const roles = this.store.collection('roles');
    // El `role: 'admin'` heredado equivale a superadministración (M-0169).
    const codes = user.role === 'admin' ? ['superadmin', ...(user.roleCodes || [])] : user.roleCodes || [];
    return {
      id: user.id,
      type: 'user',
      email: user.email,
      name: user.name,
      role: user.role,
      permissions: this.rbac.expand(codes, roles),
      channelScope: user.channelScope || [],
      locale: user.locale || 'es',
    };
  }

  async createWithPassword(input, ctx = null) {
    // `password` no forma parte del modelo: se separa antes de validar el resto.
    const { password: rawPassword, ...rest } = input || {};
    const data = this.sanitize(rest);
    const password = String(rawPassword || '');
    assertPasswordPolicy(password, { minLength: this.config.security.passwordMinLength });
    const salt = randomUUID();
    const record = await this.store.transaction(state => this.repository.insert(state, {
      ...data,
      salt,
      passwordHash: hashPassword(password, salt, this.config.security.scrypt.cost),
      passwordCost: this.config.security.scrypt.cost,
      failedLogins: 0,
      lockedUntil: null,
      lastLoginAt: null,
    }));
    await this.emit('created', this.publicView(record), ctx);
    return this.publicView(record);
  }

  async setPassword(userId, password, ctx = null) {
    assertPasswordPolicy(password, { minLength: this.config.security.passwordMinLength });
    const salt = randomUUID();
    const result = await this.store.transaction(state => this.repository.patch(state, userId, {
      salt,
      passwordHash: hashPassword(password, salt, this.config.security.scrypt.cost),
      passwordCost: this.config.security.scrypt.cost,
      passwordChangedAt: now(),
      failedLogins: 0,
      lockedUntil: null,
    }));
    await this.emit('password_changed', { id: userId }, ctx);
    return result.after;
  }

  async registerFailedLogin(userId) {
    const { loginMaxAttempts, loginLockMinutes } = this.config.security;
    return this.store.transaction(state => {
      const user = (state.users || []).find(row => row.id === userId);
      if (!user) return null;
      user.failedLogins = (user.failedLogins || 0) + 1;
      // Bloqueo temporal tras intentos fallidos (M-0255).
      if (user.failedLogins >= loginMaxAttempts) user.lockedUntil = plusMinutes(now(), loginLockMinutes);
      return user;
    });
  }

  isLocked(user) {
    const until = toDate(user?.lockedUntil);
    return Boolean(until && until.getTime() > Date.now());
  }

  async registerSuccessfulLogin(userId) {
    return this.store.transaction(state => {
      const user = (state.users || []).find(row => row.id === userId);
      if (!user) return null;
      user.failedLogins = 0;
      user.lockedUntil = null;
      user.lastLoginAt = now();
      return user;
    });
  }
}

export class SessionService {
  constructor({ store, events, config, users, collection = 'sessions' }) {
    this.store = store;
    this.events = events;
    this.config = config;
    this.users = users;
    this.collection = collection;
  }

  async create({ userId, ip, userAgent, channelId = null }) {
    const record = {
      id: `ses_${generateToken(24)}`,
      userId,
      ip: ip || null,
      userAgent: (userAgent || '').slice(0, 300),
      channelId,
      csrfToken: issueCsrfToken(),
      createdAt: now(),
      lastSeenAt: now(),
      expiresAt: new Date(Date.now() + this.config.session.ttlMs).toISOString(),
      absoluteExpiresAt: new Date(Date.now() + this.config.session.absoluteTtlMs).toISOString(),
      revokedAt: null,
    };
    await this.store.transaction(state => {
      if (!Array.isArray(state[this.collection])) state[this.collection] = [];
      state[this.collection].unshift(record);
      // Purga oportunista: las sesiones caducadas no se acumulan para siempre.
      state[this.collection] = state[this.collection].filter(
        session => !session.revokedAt && toDate(session.absoluteExpiresAt)?.getTime() > Date.now(),
      ).slice(0, 5000);
    });
    return record;
  }

  find(sessionId) {
    if (!sessionId) return null;
    const session = this.store.collection(this.collection).find(row => row.id === sessionId);
    if (!session || session.revokedAt) return null;
    if ((toDate(session.expiresAt)?.getTime() ?? 0) <= Date.now()) return null;
    if ((toDate(session.absoluteExpiresAt)?.getTime() ?? Infinity) <= Date.now()) return null;
    return session;
  }

  /** Renueva la ventana deslizante, como máximo una vez por minuto. */
  async touch(sessionId) {
    const session = this.find(sessionId);
    if (!session) return null;
    if (Date.now() - (toDate(session.lastSeenAt)?.getTime() ?? 0) < 60_000) return session;
    return this.store.transaction(state => {
      const row = (state[this.collection] || []).find(entry => entry.id === sessionId);
      if (!row) return null;
      row.lastSeenAt = now();
      const absolute = toDate(row.absoluteExpiresAt)?.getTime() ?? Date.now();
      row.expiresAt = new Date(Math.min(Date.now() + this.config.session.ttlMs, absolute)).toISOString();
      return row;
    });
  }

  async revoke(sessionId) {
    return this.store.transaction(state => {
      const row = (state[this.collection] || []).find(entry => entry.id === sessionId);
      if (!row) return null;
      row.revokedAt = now();
      return row;
    });
  }

  /** Todas las sesiones de un usuario: se usa al cambiar la contraseña (M-0253). */
  async revokeAllFor(userId, { exceptId = null } = {}) {
    return this.store.transaction(state => {
      let count = 0;
      for (const row of state[this.collection] || []) {
        if (row.userId === userId && !row.revokedAt && row.id !== exceptId) {
          row.revokedAt = now();
          count += 1;
        }
      }
      return count;
    });
  }

  listFor(userId) {
    return this.store
      .collection(this.collection)
      .filter(row => row.userId === userId && !row.revokedAt
        && (toDate(row.expiresAt)?.getTime() ?? 0) > Date.now()
        && (toDate(row.absoluteExpiresAt)?.getTime() ?? 0) > Date.now())
      .map(row => ({
        id: `${row.id.slice(0, 12)}…`,
        ip: row.ip,
        userAgent: row.userAgent,
        createdAt: row.createdAt,
        lastSeenAt: row.lastSeenAt,
        expiresAt: row.expiresAt,
      }));
  }
}

export class ApiKeyService extends BaseService {
  constructor(deps) {
    super(deps, apiKeyResource);
    this.rbac = deps.rbac;
    this.permissions = deps.permissions;
  }

  async issue(input, ctx = null) {
    const data = this.sanitize(input);
    const unknown = (data.permissions || []).filter(permission => !this.permissions.exists(permission));
    if (unknown.length) throw ValidationError.single('permissions', `Permisos no reconocidos: ${unknown.join(', ')}.`);

    const secret = generateToken(32);
    const prefix = `nd_${data.type === 'publishable' ? 'pk' : 'sk'}_${secret.slice(0, 8)}`;
    const record = await this.store.transaction(state => this.repository.insert(state, {
      ...data,
      prefix,
      // Solo se guarda el hash: el secreto se muestra una vez y no se puede recuperar.
      secretHash: createHmac('sha256', 'ndivepa-api-key').update(secret).digest('hex'),
      revokedAt: null,
      lastUsedAt: null,
      lastUsedIp: null,
      usageCount: 0,
    }));
    await this.emit('created', { id: record.id, prefix }, ctx);
    return { ...this.publicView(record), secret: `${prefix}.${secret}` };
  }

  publicView(record) {
    if (!record) return null;
    const { secretHash, ...rest } = record;
    return { ...rest, secretPreview: mask(record.prefix || '', 12) };
  }

  verify(presented) {
    const [prefix, secret] = String(presented || '').split('.');
    if (!prefix || !secret) return null;
    const key = this.repository.all().find(row => row.prefix === prefix && !row.revokedAt);
    if (!key) return null;
    if (key.expiresAt && (toDate(key.expiresAt)?.getTime() ?? 0) < Date.now()) return null;
    const expected = createHmac('sha256', 'ndivepa-api-key').update(secret).digest('hex');
    if (!safeEqual(expected, key.secretHash)) return null;
    return key;
  }

  async registerUse(keyId, ip) {
    return this.store.transaction(state => {
      const row = (state[this.resource.collection] || []).find(entry => entry.id === keyId);
      if (!row) return null;
      row.lastUsedAt = now();
      row.lastUsedIp = ip || null;
      row.usageCount = (row.usageCount || 0) + 1;
      return row;
    });
  }

  async revoke(keyId, ctx = null) {
    const result = await this.store.transaction(state => this.repository.patch(state, keyId, { revokedAt: now() }));
    await this.emit('revoked', this.publicView(result.after), ctx);
    return this.publicView(result.after);
  }

  toActor(key) {
    const roles = this.store.collection('roles');
    return {
      id: key.id,
      type: 'api_key',
      name: key.name,
      permissions: new Set([...(key.permissions || []), ...this.rbac.expand(key.roleCodes || [], roles)]),
      channelScope: key.channelScope || [],
    };
  }
}

export class InviteService extends BaseService {
  constructor(deps) {
    super(deps, inviteResource);
    this.users = deps.users;
    this.notifications = deps.notifications;
    this.settings = deps.settings;
  }

  async create(input, ctx = null) {
    const data = this.sanitize(input);
    if (this.users.byEmail(data.email)) throw new ConflictError('Ya existe un usuario con ese correo.');
    const inviteToken = generateToken(24);
    const record = await this.store.transaction(state => this.repository.insert(state, {
      ...data,
      token: inviteToken,
      status: 'pending',
      expiresAt: data.expiresAt || new Date(Date.now() + 7 * 86_400_000).toISOString(),
      acceptedAt: null,
    }));
    await this.emit('created', { id: record.id, email: record.email }, ctx);
    await this.notifications?.send({
      template: 'user.invited',
      to: record.email,
      entityId: record.id,
      data: { store: this.settings.get('storeName', 'Ndivepa'), token: inviteToken },
    });
    // El token se devuelve una única vez: no hay proveedor de correo que lo entregue.
    return { ...record, token: inviteToken };
  }

  async accept({ token: presented, name, password }) {
    const invite = this.repository.all({ status: 'pending' }).find(row => safeEqual(row.token, presented));
    if (!invite) throw new UnauthorizedError('La invitación no existe o ya se usó.');
    if ((toDate(invite.expiresAt)?.getTime() ?? 0) < Date.now()) {
      throw new UnauthorizedError('La invitación ha caducado.');
    }
    const user = await this.users.createWithPassword({
      name,
      email: invite.email,
      role: 'staff',
      roleCodes: invite.roleCodes,
      channelScope: invite.channelScope,
      status: 'active',
      password,
    });
    await this.store.transaction(state => this.repository.patch(state, invite.id, {
      status: 'accepted',
      acceptedAt: now(),
      token: null,
      userId: user.id,
    }));
    return user;
  }

  async revoke(inviteId, ctx = null) {
    const result = await this.store.transaction(state => this.repository.patch(state, inviteId, { status: 'revoked', token: null }));
    await this.emit('revoked', result.after, ctx);
    return result.after;
  }
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(input) {
  const normalized = String(input || '').toUpperCase().replace(/=+$/, '').replace(/[\s-]/g, '');
  if (!normalized || [...normalized].some(char => !BASE32.includes(char))) return null;
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of normalized) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

const backupCodeHash = code => createHash('sha256').update(String(code || '').trim().toUpperCase()).digest('hex');

/** TOTP RFC-6238 compatible con aplicaciones autenticadoras (secreto Base32). */
export const totp = {
  secret: () => base32Encode(randomBytes(20)),

  code(secret, timeStep = Math.floor(Date.now() / 30_000)) {
    const key = base32Decode(secret);
    // RFC-6238 hereda la recomendacion de claves de al menos 128 bits de HOTP.
    // Esto tambien evita aceptar texto casual formado solo por letras Base32.
    if (!key || key.length < 16 || !Number.isSafeInteger(timeStep) || timeStep < 0) return null;
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(timeStep));
    const digest = createHmac('sha1', key).update(counter).digest();
    const offset = digest[digest.length - 1] & 0x0f;
    const binary = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
    return String(binary % 1_000_000).padStart(6, '0');
  },

  /** Acepta el paso anterior y el siguiente: los relojes nunca están perfectos. */
  verify(secret, presented) {
    const candidate = String(presented || '').trim();
    if (!/^\d{6}$/.test(candidate)) return false;
    const step = Math.floor(Date.now() / 30_000);
    return [step - 1, step, step + 1].some(window => safeEqual(totp.code(secret, window), candidate));
  },
};

export class AuthService {
  constructor({ store, events, audit, config, users, sessions, notifications }) {
    this.store = store;
    this.events = events;
    this.audit = audit;
    this.config = config;
    this.users = users;
    this.sessions = sessions;
    this.notifications = notifications;
  }

  async login({ email, password, code = null, ip, userAgent }) {
    const user = this.users.byEmail(email);
    // Mensaje idéntico en todos los fallos: no se revela si el correo existe.
    const invalid = new UnauthorizedError('Correo o contraseña incorrectos.');
    if (!user || !password) {
      // Mantiene un coste parecido cuando el correo no existe para no convertir
      // el tiempo de respuesta en un enumerador de cuentas.
      verifyPassword(password || '', 'ndivepa-dummy-salt', '00'.repeat(64), this.config.security.scrypt.cost);
      throw invalid;
    }
    if (this.users.isLocked(user)) {
      throw new UnauthorizedError('La cuenta está bloqueada temporalmente por intentos fallidos.');
    }
    if (user.status !== 'active') throw new ForbiddenError('La cuenta no está activa.');
    if (!verifyPassword(password, user.salt, user.passwordHash, user.passwordCost || 16_384)) {
      await this.users.registerFailedLogin(user.id);
      await this.audit?.record({ action: 'login_failed', entity: 'user', entityId: user.id, note: ip || null });
      throw invalid;
    }
    if (user.twoFactor?.enabled) {
      if (!code) throw new UnauthorizedError('Introduce el código de verificación en dos pasos.');
      const presentedBackupHash = backupCodeHash(code);
      const legacyBackup = (user.twoFactor.backupCodes || []).some(backup => safeEqual(backup, String(code).trim().toUpperCase()));
      const hashedBackup = (user.twoFactor.backupCodeHashes || []).some(hash => safeEqual(hash, presentedBackupHash));
      const backupAccepted = legacyBackup || hashedBackup;
      const ok = totp.verify(user.twoFactor.secret, code) || backupAccepted;
      if (!ok) {
        await this.users.registerFailedLogin(user.id);
        throw new UnauthorizedError('El código de verificación no es válido.');
      }
      if (backupAccepted) {
        await this.store.transaction(state => {
          const row = (state.users || []).find(entry => entry.id === user.id);
          row.twoFactor.backupCodes = (row.twoFactor.backupCodes || []).filter(backup => !safeEqual(backup, String(code).trim().toUpperCase()));
          row.twoFactor.backupCodeHashes = (row.twoFactor.backupCodeHashes || []).filter(hash => !safeEqual(hash, presentedBackupHash));
        });
      }
    }

    await this.users.registerSuccessfulLogin(user.id);
    const session = await this.sessions.create({ userId: user.id, ip, userAgent });
    await this.events.emit('auth.login', { userId: user.id, sessionId: session.id, ip });
    await this.audit?.record({ action: 'login', entity: 'user', entityId: user.id, note: ip || null });
    return { user: this.users.publicView(this.users.repository.retrieve(user.id)), session };
  }

  async logout(sessionId) {
    if (!sessionId) return false;
    await this.sessions.revoke(sessionId);
    await this.events.emit('auth.logout', { sessionId });
    return true;
  }

  async changePassword({ userId, currentPassword, newPassword, sessionId = null }) {
    const user = this.store.collection('users').find(row => row.id === userId);
    if (!user) throw new UnauthorizedError();
    if (!verifyPassword(currentPassword, user.salt, user.passwordHash, user.passwordCost || 16_384)) {
      throw ValidationError.single('currentPassword', 'La contraseña actual no es correcta.');
    }
    if (verifyPassword(newPassword, user.salt, user.passwordHash, user.passwordCost || 16_384)) {
      throw ValidationError.single('newPassword', 'La contraseña nueva debe ser distinta de la actual.');
    }
    await this.users.setPassword(userId, newPassword);
    const revoked = await this.sessions.revokeAllFor(userId, { exceptId: sessionId });
    await this.audit?.record({ action: 'password_changed', entity: 'user', entityId: userId, note: `sesiones revocadas: ${revoked}` });
    return { message: 'Contraseña actualizada.', revokedSessions: revoked };
  }

  async enableTwoFactor(userId) {
    const secret = totp.secret();
    const backupCodes = Array.from({ length: 8 }, () => base32Encode(randomBytes(5)).slice(0, 8));
    await this.store.transaction(state => {
      const row = (state.users || []).find(entry => entry.id === userId);
      if (!row) return null;
      row.twoFactor = { enabled: false, secret, backupCodes: [], backupCodeHashes: backupCodes.map(backupCodeHash), confirmedAt: null };
      return row;
    });
    // Se devuelve una sola vez, antes de confirmar con el primer código válido.
    const user = this.store.collection('users').find(row => row.id === userId);
    const label = encodeURIComponent(`Ndivepa:${user?.email || userId}`);
    return { secret, backupCodes, otpauth: `otpauth://totp/${label}?secret=${secret}&issuer=Ndivepa&algorithm=SHA1&digits=6&period=30` };
  }

  async confirmTwoFactor(userId, code) {
    const user = this.store.collection('users').find(row => row.id === userId);
    if (!user?.twoFactor?.secret) throw new ConflictError('Primero genera el secreto de verificación en dos pasos.');
    if (!totp.verify(user.twoFactor.secret, code)) throw ValidationError.single('code', 'El código no es válido.');
    await this.store.transaction(state => {
      const row = (state.users || []).find(entry => entry.id === userId);
      row.twoFactor = { ...row.twoFactor, enabled: true, confirmedAt: now() };
    });
    return { enabled: true };
  }

  async disableTwoFactor(userId, password) {
    const user = this.store.collection('users').find(row => row.id === userId);
    if (!verifyPassword(password, user?.salt, user?.passwordHash, user?.passwordCost || 16_384)) {
      throw ValidationError.single('password', 'La contraseña no es correcta.');
    }
    await this.store.transaction(state => {
      const row = (state.users || []).find(entry => entry.id === userId);
      row.twoFactor = { enabled: false, secret: null, backupCodes: [], backupCodeHashes: [], confirmedAt: null };
    });
    return { enabled: false };
  }
}

export default {
  name: 'access',
  requires: ['store', 'events', 'audit', 'config', 'customFields', 'rbac', 'permissions', 'notifications', 'settings'],
  resources: [roleResource, userResource, inviteResource, apiKeyResource],
  permissions: [
    { resource: 'user', description: 'Usuarios de administración.' },
    { resource: 'role', description: 'Roles y permisos.' },
    { resource: 'invite', description: 'Invitaciones de administración.' },
    { resource: 'apiKey', description: 'Claves de API.' },
    { resource: 'session', actions: ['read', 'delete'], description: 'Sesiones activas.' },
  ],

  register(deps) {
    const roles = new RoleService(deps);
    const users = new UserService({ ...deps, roles });
    const sessions = new SessionService({ ...deps, users });
    const apiKeys = new ApiKeyService(deps);
    const invites = new InviteService({ ...deps, users });
    const auth = new AuthService({ ...deps, users, sessions });
    return { roles, users, sessions, apiKeys, invites, auth };
  },

  async seed(service) {
    await service.roles.seed(DEFAULT_ROLES.map(role => ({ ...role, id: `role_${role.code}` })), 'code');
  },

  routes: {
    admin: container => {
      const module = () => container.resolve('access');
      const minLength = () => container.resolve('config').security.passwordMinLength;
      return [
        ...crudRoutes(roleResource, () => module().roles, { tags: ['acceso'] }),
        {
          method: 'GET',
          path: '/permissions',
          permission: 'role:read',
          summary: 'Catálogo de permisos declarados por los módulos.',
          tags: ['acceso'],
          bodyless: true,
          handler: () => ({ data: container.resolve('permissions').catalog(), count: container.resolve('permissions').all().length }),
        },
        {
          method: 'GET',
          path: '/users',
          permission: 'user:read',
          summary: 'Lista usuarios de administración.',
          tags: ['acceso'],
          bodyless: true,
          handler: ctx => {
            const result = module().users.list(ctx.query);
            return { ...result, data: result.data.map(user => module().users.publicView(user)) };
          },
        },
        {
          method: 'GET',
          path: '/users/:id',
          permission: 'user:read',
          summary: 'Recupera un usuario.',
          tags: ['acceso'],
          bodyless: true,
          handler: ctx => module().users.publicView(module().users.repository.retrieve(ctx.params.id)),
        },
        {
          method: 'POST',
          path: '/users',
          permission: 'user:create',
          summary: 'Crea un usuario con contraseña.',
          tags: ['acceso'],
          status: 201,
          body: { ...userResource.fields, password: { type: 'string', required: true, minLength: 12, maxLength: 200 } },
          handler: ctx => module().users.createWithPassword(ctx.body, ctx),
        },
        {
          method: 'PATCH',
          path: '/users/:id',
          permission: 'user:update',
          summary: 'Actualiza un usuario.',
          tags: ['acceso'],
          body: userResource.fields,
          handler: async ctx => module().users.publicView(await module().users.update(ctx.params.id, ctx.body, ctx)),
        },
        {
          method: 'DELETE',
          path: '/users/:id',
          permission: 'user:delete',
          summary: 'Desactiva un usuario.',
          tags: ['acceso'],
          bodyless: true,
          handler: async ctx => {
            if (ctx.actor?.id === ctx.params.id) throw new ConflictError('No puedes borrar tu propia cuenta.');
            const remaining = module().users.repository.all({ role: 'admin' }).filter(user => user.id !== ctx.params.id);
            if (!remaining.length) throw new ConflictError('Debe quedar al menos una cuenta de administración.');
            return module().users.publicView(await module().users.delete(ctx.params.id, ctx));
          },
        },
        {
          method: 'POST',
          path: '/users/:id/password',
          permission: 'user:update',
          summary: 'Define la contraseña de un usuario.',
          tags: ['acceso'],
          body: { password: { type: 'string', required: true, minLength: 12, maxLength: 200 } },
          handler: async ctx => {
            await module().users.setPassword(ctx.params.id, ctx.body.password, ctx);
            const revoked = await module().sessions.revokeAllFor(ctx.params.id);
            return { message: 'Contraseña actualizada.', revokedSessions: revoked };
          },
        },
        {
          method: 'GET',
          path: '/users/:id/sessions',
          permission: 'session:read',
          summary: 'Sesiones activas de un usuario.',
          tags: ['acceso'],
          bodyless: true,
          handler: ctx => {
            const data = module().sessions.listFor(ctx.params.id);
            return { data, count: data.length };
          },
        },
        {
          method: 'DELETE',
          path: '/users/:id/sessions',
          permission: 'session:delete',
          summary: 'Revoca todas las sesiones de un usuario.',
          tags: ['acceso'],
          bodyless: true,
          handler: async ctx => ({ revoked: await module().sessions.revokeAllFor(ctx.params.id) }),
        },
        {
          method: 'GET',
          path: '/invites',
          permission: 'invite:read',
          summary: 'Invitaciones emitidas.',
          tags: ['acceso'],
          bodyless: true,
          handler: ctx => {
            const result = module().invites.list(ctx.query);
            return { ...result, data: result.data.map(({ token: _token, ...rest }) => rest) };
          },
        },
        {
          method: 'POST',
          path: '/invites',
          permission: 'invite:create',
          summary: 'Invita a una persona a administrar. Devuelve el token una sola vez.',
          tags: ['acceso'],
          status: 201,
          body: inviteResource.fields,
          handler: ctx => module().invites.create(ctx.body, ctx),
        },
        {
          method: 'POST',
          path: '/invites/:id/revoke',
          permission: 'invite:delete',
          summary: 'Revoca una invitación pendiente.',
          tags: ['acceso'],
          handler: ctx => module().invites.revoke(ctx.params.id, ctx),
        },
        {
          method: 'GET',
          path: '/api-keys',
          permission: 'apiKey:read',
          summary: 'Claves de API emitidas.',
          tags: ['acceso'],
          bodyless: true,
          handler: ctx => {
            const result = module().apiKeys.list(ctx.query);
            return { ...result, data: result.data.map(key => module().apiKeys.publicView(key)) };
          },
        },
        {
          method: 'POST',
          path: '/api-keys',
          permission: 'apiKey:create',
          summary: 'Emite una clave de API. El secreto se muestra una única vez.',
          tags: ['acceso'],
          status: 201,
          body: apiKeyResource.fields,
          handler: ctx => module().apiKeys.issue(ctx.body, ctx),
        },
        {
          method: 'POST',
          path: '/api-keys/:id/revoke',
          permission: 'apiKey:delete',
          summary: 'Revoca una clave de API.',
          tags: ['acceso'],
          handler: ctx => module().apiKeys.revoke(ctx.params.id, ctx),
        },
      ];
    },

    /** Rutas de autenticación: públicas por diseño, con rate limit propio. */
    auth: container => {
      const module = () => container.resolve('access');
      const config = () => container.resolve('config');
      return [
        {
          method: 'GET',
          path: '/auth/me',
          permission: null,
          summary: 'Actor de la sesión actual.',
          tags: ['auth'],
          bodyless: true,
          handler: ctx => {
            if (!ctx.actor || ctx.actor.type !== 'user') return { user: null };
            const user = module().users.repository.byId(ctx.actor.id);
            return {
              user: module().users.publicView(user),
              permissions: [...ctx.actor.permissions].sort(),
              csrfToken: ctx.session?.csrfToken || null,
            };
          },
        },
        {
          method: 'POST',
          path: '/auth/login',
          permission: null,
          csrf: false,
          summary: 'Inicia sesión y emite la cookie de sesión.',
          tags: ['auth'],
          body: {
            email: rule.email({ required: true }),
            password: { type: 'string', required: true, maxLength: 200 },
            code: rule.text(12),
          },
          handler: async ctx => {
            const { user, session } = await module().auth.login({
              ...ctx.body,
              ip: ctx.ip,
              userAgent: ctx.userAgent,
            });
            const settings = config().session;
            ctx.res.writeHead(200, {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'no-store',
              'Set-Cookie': [
                respond.cookie(settings.cookieName, session.id, { maxAge: settings.ttlMs / 1000, secure: settings.secure, sameSite: 'Strict' }),
                respond.cookie(config().security.csrfCookie, session.csrfToken, {
                  maxAge: settings.ttlMs / 1000,
                  httpOnly: false,
                  secure: settings.secure,
                  sameSite: 'Strict',
                }),
              ],
            });
            ctx.res.end(JSON.stringify({ user, csrfToken: session.csrfToken }));
          },
        },
        {
          method: 'POST',
          path: '/auth/logout',
          permission: null,
          summary: 'Cierra la sesión actual.',
          tags: ['auth'],
          handler: async ctx => {
            await module().auth.logout(ctx.session?.id);
            ctx.res.writeHead(204, {
              'Set-Cookie': [
                respond.clearCookie(config().session.cookieName),
                respond.clearCookie(config().security.csrfCookie, { httpOnly: false }),
              ],
            });
            ctx.res.end();
          },
        },
        {
          method: 'POST',
          path: '/auth/password',
          permission: null,
          summary: 'Cambia la contraseña de la sesión actual.',
          tags: ['auth'],
          body: {
            currentPassword: { type: 'string', required: true, maxLength: 200 },
            newPassword: { type: 'string', required: true, maxLength: 200 },
          },
          handler: ctx => {
            if (!ctx.actor || ctx.actor.type !== 'user') throw new UnauthorizedError();
            return module().auth.changePassword({
              userId: ctx.actor.id,
              currentPassword: ctx.body.currentPassword,
              newPassword: ctx.body.newPassword,
              sessionId: ctx.session?.id || null,
            });
          },
        },
        {
          method: 'GET',
          path: '/auth/sessions',
          permission: null,
          summary: 'Sesiones activas propias.',
          tags: ['auth'],
          bodyless: true,
          handler: ctx => {
            if (!ctx.actor) throw new UnauthorizedError();
            const data = module().sessions.listFor(ctx.actor.id);
            return { data, count: data.length };
          },
        },
        {
          method: 'POST',
          path: '/auth/2fa/enable',
          permission: null,
          summary: 'Genera el secreto de verificación en dos pasos.',
          tags: ['auth'],
          handler: ctx => {
            if (!ctx.actor) throw new UnauthorizedError();
            // `FEATURE_2FA` existía en la configuración pero no lo leía nadie:
            // apagarlo dejaba la inscripción abierta igual. Aquí se cierra el
            // alta; los usuarios que ya lo tengan activo siguen verificándose.
            assertTwoFactorEnabled(container);
            return module().auth.enableTwoFactor(ctx.actor.id);
          },
        },
        {
          method: 'POST',
          path: '/auth/2fa/confirm',
          permission: null,
          summary: 'Confirma la verificación en dos pasos con el primer código.',
          tags: ['auth'],
          body: { code: rule.text(12, { required: true }) },
          handler: ctx => {
            if (!ctx.actor) throw new UnauthorizedError();
            assertTwoFactorEnabled(container);
            return module().auth.confirmTwoFactor(ctx.actor.id, ctx.body.code);
          },
        },
        {
          method: 'POST',
          path: '/auth/2fa/disable',
          permission: null,
          summary: 'Desactiva la verificación en dos pasos.',
          tags: ['auth'],
          body: { password: { type: 'string', required: true, maxLength: 200 } },
          handler: ctx => {
            if (!ctx.actor) throw new UnauthorizedError();
            return module().auth.disableTwoFactor(ctx.actor.id, ctx.body.password);
          },
        },
        {
          method: 'POST',
          path: '/auth/invites/accept',
          permission: null,
          csrf: false,
          summary: 'Acepta una invitación y crea la cuenta.',
          tags: ['auth'],
          status: 201,
          body: {
            token: rule.text(200, { required: true }),
            name: rule.text(120, { required: true }),
            password: { type: 'string', required: true, minLength: 12, maxLength: 200 },
          },
          handler: ctx => module().invites.accept(ctx.body),
        },
      ];
    },
  },

  /** Autenticadores para el pipeline: sesión por cookie y clave de API. */
  authenticators: container => [
    async ctx => {
      const module = container.resolve('access');
      const cookieName = container.resolve('config').session.cookieName;
      const sessionId = ctx.cookies[cookieName];
      if (!sessionId) return null;
      const session = module.sessions.find(sessionId);
      if (!session) return null;
      const user = module.users.repository.byId(session.userId);
      if (!user || user.status === 'suspended') return null;
      await module.sessions.touch(sessionId);
      return { actor: module.users.toActor(user), session, stop: true };
    },
    async ctx => {
      const header = ctx.req.headers.authorization;
      if (!header?.startsWith('Bearer ')) return null;
      const module = container.resolve('access');
      const key = module.apiKeys.verify(header.slice(7).trim());
      if (!key) throw new UnauthorizedError('La clave de API no es válida o está revocada.');
      await module.apiKeys.registerUse(key.id, ctx.ip);
      return { actor: module.apiKeys.toActor(key), apiKey: key, stop: true };
    },
  ],
};
