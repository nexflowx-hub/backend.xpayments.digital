import { Response } from 'express';
import prisma from '../../../core/prisma';
import { ControlPlaneRequest } from '../middleware/control-plane-auth.middleware';
import { writeControlPlaneAudit } from '../services/control-plane-audit.service';

const TICKET_STATUSES = new Set(['OPEN','IN_PROGRESS','WAITING_CUSTOMER','WAITING_INTERNAL','RESOLVED','CLOSED']);
const TICKET_PRIORITIES = new Set(['LOW','NORMAL','HIGH','URGENT']);
const text = (v: unknown, max = 4000) => String(v ?? '').trim().slice(0, max);
const nullableUuid = (v: unknown) => text(v, 80) || null;

async function linkedEntities(merchantId: string | null, storeId: string | null, orderId: string | null) {
  let resolvedMerchant = merchantId;
  if (storeId) {
    const rows = await prisma.$queryRawUnsafe<any[]>(`select id,merchant_id from stores where id=$1::uuid limit 1`, storeId);
    if (!rows[0]) throw new Error('STORE_NOT_FOUND');
    if (resolvedMerchant && String(rows[0].merchant_id) !== resolvedMerchant) throw new Error('STORE_MERCHANT_MISMATCH');
    resolvedMerchant = String(rows[0].merchant_id);
  }
  if (orderId) {
    const rows = await prisma.$queryRawUnsafe<any[]>(`select id,merchant_id from service_orders where id=$1::uuid limit 1`, orderId);
    if (!rows[0]) throw new Error('ORDER_NOT_FOUND');
    if (resolvedMerchant && String(rows[0].merchant_id) !== resolvedMerchant) throw new Error('ORDER_MERCHANT_MISMATCH');
    resolvedMerchant = String(rows[0].merchant_id);
  }
  if (resolvedMerchant) {
    const rows = await prisma.$queryRawUnsafe<any[]>(`select id from merchants where id=$1::uuid limit 1`, resolvedMerchant);
    if (!rows[0]) throw new Error('MERCHANT_NOT_FOUND');
  }
  return resolvedMerchant;
}

export async function listSupportTickets(req: ControlPlaneRequest, res: Response) {
  try {
    const status = text(req.query.status, 40).toUpperCase();
    const priority = text(req.query.priority, 40).toUpperCase();
    const search = text(req.query.search, 200);
    const merchantId = text(req.query.merchantId, 80);
    const rows = await prisma.$queryRawUnsafe<any[]>(`
      select t.*, m.name merchant_name, m.email merchant_email, s.store_code, s.name store_name,
             so.order_code, u.name assigned_to_name, u.email assigned_to_email,
             (select count(*)::int from support_ticket_messages x where x.ticket_id=t.id) message_count,
             (select max(created_at) from support_ticket_messages x where x.ticket_id=t.id) last_message_at
      from support_tickets t
      left join merchants m on m.id=t.merchant_id
      left join stores s on s.id=t.store_id
      left join service_orders so on so.id=t.service_order_id
      left join control_plane_users u on u.id=t.assigned_to_user_id
      where ($1='' or t.status=$1)
        and ($2='' or t.priority=$2)
        and ($3='' or t.merchant_id=$3::uuid)
        and ($4='' or t.ticket_code ilike '%'||$4||'%' or t.subject ilike '%'||$4||'%' or coalesce(m.name,'') ilike '%'||$4||'%' or coalesce(m.email,'') ilike '%'||$4||'%')
      order by case t.priority when 'URGENT' then 1 when 'HIGH' then 2 when 'NORMAL' then 3 else 4 end, t.updated_at desc
      limit 300
    `, status, priority, merchantId, search);
    return res.json({ success:true, data:{ tickets:rows } });
  } catch (error:any) {
    console.error('[control-plane.tickets.list]', error?.message || error);
    return res.status(500).json({success:false,error:{code:'TICKET_LIST_ERROR',message:'Falha ao carregar tickets.'}});
  }
}

export async function getSupportTicket(req: ControlPlaneRequest, res: Response) {
  try {
    const id = text(req.params.id, 80);
    const rows = await prisma.$queryRawUnsafe<any[]>(`
      select t.*, m.name merchant_name,m.email merchant_email,s.store_code,s.name store_name,so.order_code,
             u.name assigned_to_name,u.email assigned_to_email
      from support_tickets t
      left join merchants m on m.id=t.merchant_id
      left join stores s on s.id=t.store_id
      left join service_orders so on so.id=t.service_order_id
      left join control_plane_users u on u.id=t.assigned_to_user_id
      where t.id=$1::uuid limit 1`, id);
    if (!rows[0]) return res.status(404).json({success:false,error:{code:'NOT_FOUND',message:'Ticket não encontrado.'}});
    const messages = await prisma.$queryRawUnsafe<any[]>(`
      select x.*,u.name control_plane_user_name,u.email control_plane_user_email,m.name merchant_name,m.email merchant_email
      from support_ticket_messages x
      left join control_plane_users u on u.id=x.control_plane_user_id
      left join merchants m on m.id=x.merchant_id
      where x.ticket_id=$1::uuid order by x.created_at`, id);
    return res.json({success:true,data:{ticket:rows[0],messages}});
  } catch(error:any) {
    console.error('[control-plane.tickets.get]', error?.message || error);
    return res.status(500).json({success:false,error:{code:'TICKET_READ_ERROR',message:'Falha ao carregar ticket.'}});
  }
}

export async function createSupportTicket(req: ControlPlaneRequest, res: Response) {
  try {
    const actor = req.controlPlane!;
    const subject = text(req.body?.subject, 300);
    if (!subject) return res.status(400).json({success:false,error:{code:'SUBJECT_REQUIRED',message:'Assunto obrigatório.'}});
    const merchantId = nullableUuid(req.body?.merchantId);
    const storeId = nullableUuid(req.body?.storeId);
    const serviceOrderId = nullableUuid(req.body?.serviceOrderId);
    const resolvedMerchant = await linkedEntities(merchantId, storeId, serviceOrderId);
    const priority = text(req.body?.priority || 'NORMAL', 40).toUpperCase();
    if (!TICKET_PRIORITIES.has(priority)) return res.status(400).json({success:false,error:{code:'BAD_PRIORITY',message:'Prioridade inválida.'}});
    const category = text(req.body?.category || (serviceOrderId ? 'XPAY_EXPERT' : 'SUPPORT'), 80).toUpperCase();
    const description = text(req.body?.description, 12000) || null;
    const code = `TKT-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${Math.random().toString(36).slice(2,8).toUpperCase()}`;
    const tags = Array.isArray(req.body?.tags) ? req.body.tags.map((x:unknown)=>text(x,80)).filter(Boolean).slice(0,30) : [];
    const result = await prisma.$queryRawUnsafe<any[]>(`
      insert into support_tickets(ticket_code,merchant_id,store_id,service_order_id,category,subject,description,status,priority,channel,requester_name,requester_email,assigned_to_user_id,created_by_control_plane_user_id,tags,metadata)
      values($1,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,'OPEN',$8,$9,$10,$11,$12::uuid,$13::uuid,$14::jsonb,$15::jsonb)
      returning *`, code,resolvedMerchant,storeId,serviceOrderId,category,subject,description,priority,
      text(req.body?.channel || 'ADMIN',40).toUpperCase(), text(req.body?.requesterName,200)||null, text(req.body?.requesterEmail,320)||null,
      nullableUuid(req.body?.assignedToUserId),actor.userId,JSON.stringify(tags),JSON.stringify(req.body?.metadata && typeof req.body.metadata==='object' ? req.body.metadata : {}));
    if (description) {
      await prisma.$executeRawUnsafe(`insert into support_ticket_messages(ticket_id,author_type,control_plane_user_id,body,internal) values($1::uuid,'CONTROL_PLANE',$2::uuid,$3,false)`,String(result[0].id),actor.userId,description);
    }
    await writeControlPlaneAudit({actorUserId:actor.userId,action:'TICKET_CREATED',entityType:'support_ticket',entityId:String(result[0].id),afterData:{...result[0],description:description ? '[present]' : null},req});
    return res.status(201).json({success:true,data:{ticket:result[0]}});
  } catch(error:any) {
    const map:Record<string,string>={STORE_NOT_FOUND:'Store não encontrada.',STORE_MERCHANT_MISMATCH:'Store não pertence ao Merchant.',ORDER_NOT_FOUND:'Contratação XPay não encontrada.',ORDER_MERCHANT_MISMATCH:'Contratação não pertence ao Merchant.',MERCHANT_NOT_FOUND:'Merchant não encontrado.'};
    if(map[error?.message]) return res.status(409).json({success:false,error:{code:error.message,message:map[error.message]}});
    console.error('[control-plane.tickets.create]',error?.message||error);
    return res.status(500).json({success:false,error:{code:'TICKET_CREATE_ERROR',message:'Falha ao criar ticket.'}});
  }
}

export async function updateSupportTicket(req: ControlPlaneRequest, res: Response) {
  try {
    const actor=req.controlPlane!; const id=text(req.params.id,80);
    const before=(await prisma.$queryRawUnsafe<any[]>(`select * from support_tickets where id=$1::uuid limit 1`,id))[0];
    if(!before) return res.status(404).json({success:false,error:{code:'NOT_FOUND',message:'Ticket não encontrado.'}});
    const status=req.body?.status===undefined ? String(before.status) : text(req.body.status,40).toUpperCase();
    const priority=req.body?.priority===undefined ? String(before.priority) : text(req.body.priority,40).toUpperCase();
    if(!TICKET_STATUSES.has(status)||!TICKET_PRIORITIES.has(priority)) return res.status(400).json({success:false,error:{code:'BAD_STATE',message:'Estado ou prioridade inválidos.'}});
    const assigned=req.body?.assignedToUserId===undefined ? before.assigned_to_user_id : nullableUuid(req.body.assignedToUserId);
    if(assigned){ const u=await prisma.$queryRawUnsafe<any[]>(`select id from control_plane_users where id=$1::uuid and status='active'`,String(assigned)); if(!u[0]) return res.status(409).json({success:false,error:{code:'ASSIGNEE_INVALID',message:'Responsável interno inválido.'}}); }
    const subject=req.body?.subject===undefined ? String(before.subject) : text(req.body.subject,300);
    const category=req.body?.category===undefined ? String(before.category) : text(req.body.category,80).toUpperCase();
    const rows=await prisma.$queryRawUnsafe<any[]>(`
      update support_tickets set subject=$2,category=$3,status=$4,priority=$5,assigned_to_user_id=$6::uuid,
        resolved_at=case when $4='RESOLVED' then coalesce(resolved_at,now()) when $4 not in ('RESOLVED','CLOSED') then null else resolved_at end,
        closed_at=case when $4='CLOSED' then coalesce(closed_at,now()) when $4<>'CLOSED' then null else closed_at end,
        updated_at=now() where id=$1::uuid returning *`,id,subject,category,status,priority,assigned);
    await writeControlPlaneAudit({actorUserId:actor.userId,action:'TICKET_UPDATED',entityType:'support_ticket',entityId:id,beforeData:before,afterData:rows[0],req});
    return res.json({success:true,data:{ticket:rows[0]}});
  }catch(error:any){console.error('[control-plane.tickets.update]',error?.message||error);return res.status(500).json({success:false,error:{code:'TICKET_UPDATE_ERROR',message:'Falha ao atualizar ticket.'}});}
}

export async function addSupportTicketMessage(req: ControlPlaneRequest,res:Response){
  try{
    const actor=req.controlPlane!; const id=text(req.params.id,80); const body=text(req.body?.body,12000);
    if(!body) return res.status(400).json({success:false,error:{code:'BODY_REQUIRED',message:'Mensagem obrigatória.'}});
    const exists=await prisma.$queryRawUnsafe<any[]>(`select id from support_tickets where id=$1::uuid`,id); if(!exists[0]) return res.status(404).json({success:false,error:{code:'NOT_FOUND',message:'Ticket não encontrado.'}});
    const rows=await prisma.$queryRawUnsafe<any[]>(`insert into support_ticket_messages(ticket_id,author_type,control_plane_user_id,body,internal,attachments,metadata) values($1::uuid,'CONTROL_PLANE',$2::uuid,$3,$4,$5::jsonb,$6::jsonb) returning *`,id,actor.userId,body,req.body?.internal===true,JSON.stringify(Array.isArray(req.body?.attachments)?req.body.attachments:[]),JSON.stringify(req.body?.metadata&&typeof req.body.metadata==='object'?req.body.metadata:{}));
    await prisma.$executeRawUnsafe(`update support_tickets set updated_at=now(),status=case when status='OPEN' then 'IN_PROGRESS' else status end where id=$1::uuid`,id);
    await writeControlPlaneAudit({actorUserId:actor.userId,action:'TICKET_MESSAGE_ADDED',entityType:'support_ticket',entityId:id,metadata:{internal:req.body?.internal===true,messageId:String(rows[0].id)},req});
    return res.status(201).json({success:true,data:{message:rows[0]}});
  }catch(error:any){console.error('[control-plane.tickets.message]',error?.message||error);return res.status(500).json({success:false,error:{code:'TICKET_MESSAGE_ERROR',message:'Falha ao adicionar mensagem.'}});}
}

export async function deleteSupportTicket(req:ControlPlaneRequest,res:Response){
  try{
    const actor=req.controlPlane!; const id=text(req.params.id,80);
    const before=(await prisma.$queryRawUnsafe<any[]>(`select * from support_tickets where id=$1::uuid`,id))[0];
    if(!before) return res.status(404).json({success:false,error:{code:'NOT_FOUND',message:'Ticket não encontrado.'}});
    await prisma.$transaction(async tx=>{await tx.$executeRawUnsafe(`delete from support_ticket_messages where ticket_id=$1::uuid`,id);await tx.$executeRawUnsafe(`delete from support_tickets where id=$1::uuid`,id);});
    await writeControlPlaneAudit({actorUserId:actor.userId,action:'TICKET_DELETED',entityType:'support_ticket',entityId:id,beforeData:before,req});
    return res.json({success:true,data:{deleted:true,id}});
  }catch(error:any){console.error('[control-plane.tickets.delete]',error?.message||error);return res.status(500).json({success:false,error:{code:'TICKET_DELETE_ERROR',message:'Falha ao apagar ticket.'}});}
}
