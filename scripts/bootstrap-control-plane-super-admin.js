'use strict';

const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const email = String(process.env.CP_EMAIL || '').trim().toLowerCase();
  const name = String(process.env.CP_NAME || '').trim();
  const password = String(process.env.CP_PASSWORD || '');

  if (!email || !name || password.length < 12) {
    console.error('CONTROL_PLANE_BOOTSTRAP=FAIL');
    console.error('Email/name required and password must contain at least 12 characters.');
    process.exitCode = 2;
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const rows = await prisma.$queryRawUnsafe(
    `
    insert into control_plane_users (email,name,password_hash,role,permissions,status)
    values ($1,$2,$3,'SUPER_ADMIN','{}'::jsonb,'active')
    on conflict ((lower(email))) do update
      set name=excluded.name,
          password_hash=excluded.password_hash,
          role='SUPER_ADMIN',
          status='active',
          updated_at=now()
    returning id,email,name,role,status
    `,
    email,
    name,
    passwordHash
  );

  const user = rows[0];
  await prisma.$executeRawUnsafe(
    `
    insert into control_plane_audit_logs (actor_user_id,action,entity_type,entity_id,metadata)
    values ($1::uuid,'CONTROL_PLANE_SUPER_ADMIN_BOOTSTRAPPED','control_plane_user',$1,'{"source":"local_bootstrap"}'::jsonb)
    `,
    String(user.id)
  );

  console.log('CONTROL_PLANE_BOOTSTRAP=PASS');
  console.log(`USER_ID=${user.id}`);
  console.log(`EMAIL=${user.email}`);
  console.log(`ROLE=${user.role}`);
  console.log(`STATUS=${user.status}`);
  console.log('PASSWORD_PRINTED=NO');
}

main()
  .catch((error) => {
    console.error('CONTROL_PLANE_BOOTSTRAP=FAIL');
    console.error(error?.message || error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
