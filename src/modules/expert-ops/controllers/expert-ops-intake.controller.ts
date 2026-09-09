import { Response } from 'express';
import prisma from '../../../core/prisma';
import { AuthRequest } from '../../../middleware/auth.middleware';

const actorId=(req:AuthRequest)=>String(req.merchantId||req.user?.id||'').trim();
const clean=(value:unknown,max=3000)=>String(value??'').trim().slice(0,max);
const REVIEW_STATUSES=new Set(['SUBMITTED','REVIEWING','APPROVED','REJECTED']);
const REQUIREMENT_STATUSES=new Set(['PENDING','SUBMITTED','APPROVED','REJECTED','WAIVED']);

async function member(req:AuthRequest,permission:string){
  const actor=actorId(req); if(!actor)return null;
  const rows=await prisma.$queryRaw<any[]>`
    select merchant_id,role,permissions from expert_ops_members
    where merchant_id=cast(${actor} as uuid) and active=true limit 1
  `;
  const m=rows[0]; if(!m)return null;
  const permissions=Array.isArray(m.permissions)?m.permissions:[];
  if(m.role!=='admin'&&!permissions.includes(permission))return null;
  return m;
}

async function audit(actor:string,action:string,orderId:string,beforeData:any,afterData:any,metadata:any={}){
  await prisma.$executeRaw`
    insert into expert_ops_audit_logs(actor_merchant_id,action,entity_type,entity_id,before_data,after_data,metadata)
    values(cast(${actor} as uuid),${action},'service_order',cast(${orderId} as uuid),${JSON.stringify(beforeData??null)}::jsonb,${JSON.stringify(afterData??null)}::jsonb,${JSON.stringify(metadata)}::jsonb)
  `;
}

export const getOpsIntake=async(req:AuthRequest,res:Response)=>{
  try{
    const m=await member(req,'expert_orders_read');
    if(!m)return res.status(403).json({success:false,error:{code:'FORBIDDEN',message:'Sem acesso às operações.'}});
    const orderId=clean(req.params.orderId,80);
    const order=await prisma.$queryRaw<any[]>`select id,order_code,payment_status from service_orders where id=cast(${orderId} as uuid) limit 1`;
    if(!order[0])return res.status(404).json({success:false,error:{code:'NOT_FOUND',message:'Operação não encontrada.'}});
    const requirements=await prisma.$queryRaw<any[]>`select id,code,label,required,status,notes,metadata,created_at,updated_at from service_order_requirements where service_order_id=cast(${orderId} as uuid) order by created_at,code`;
    const documents=await prisma.$queryRaw<any[]>`select id,requirement_id,category,label,original_name,mime_type,file_size,external_url,status,review_notes,metadata,created_at,updated_at from service_order_documents where service_order_id=cast(${orderId} as uuid) order by created_at desc`;
    const proofs=await prisma.$queryRaw<any[]>`select id,payment_method,payment_reference,external_url,note,status,review_notes,metadata,created_at,updated_at from service_order_payment_proofs where service_order_id=cast(${orderId} as uuid) order by created_at desc`;
    return res.json({success:true,data:{order:{id:order[0].id,orderCode:order[0].order_code,paymentStatus:order[0].payment_status},requirements,documents,paymentProofs:proofs}});
  }catch(error:any){
    console.error('[expert-ops.intake.get]',error?.message||error);
    return res.status(500).json({success:false,error:{code:'SERVER_ERROR',message:'Não foi possível carregar os documentos do processo.'}});
  }
};

export const reviewPaymentProof=async(req:AuthRequest,res:Response)=>{
  try{
    const m=await member(req,'expert_payment_confirm');
    if(!m)return res.status(403).json({success:false,error:{code:'FORBIDDEN',message:'Sem permissão para rever pagamentos.'}});
    const orderId=clean(req.params.orderId,80),proofId=clean(req.params.proofId,80);
    const status=clean(req.body?.status,40).toUpperCase();
    const reviewNotes=clean(req.body?.reviewNotes,4000)||null;
    if(!REVIEW_STATUSES.has(status))return res.status(400).json({success:false,error:{code:'BAD_REQUEST',message:'Estado inválido.'}});
    const before=await prisma.$queryRaw<any[]>`select * from service_order_payment_proofs where id=cast(${proofId} as uuid) and service_order_id=cast(${orderId} as uuid) limit 1`;
    if(!before[0])return res.status(404).json({success:false,error:{code:'NOT_FOUND',message:'Comprovativo não encontrado.'}});
    const rows=await prisma.$queryRaw<any[]>`
      update service_order_payment_proofs set status=${status},review_notes=${reviewNotes},reviewed_by_merchant_id=cast(${m.merchant_id} as uuid),reviewed_at=now(),updated_at=now()
      where id=cast(${proofId} as uuid) returning *
    `;
    await audit(String(m.merchant_id),'PAYMENT_PROOF_REVIEWED',orderId,before[0],rows[0],{proofId,status});
    return res.json({success:true,data:{proof:rows[0]}});
  }catch(error:any){
    console.error('[expert-ops.proof.review]',error?.message||error);
    return res.status(500).json({success:false,error:{code:'SERVER_ERROR',message:'Não foi possível rever o comprovativo.'}});
  }
};

export const reviewDocument=async(req:AuthRequest,res:Response)=>{
  try{
    const m=await member(req,'expert_orders_write');
    if(!m)return res.status(403).json({success:false,error:{code:'FORBIDDEN',message:'Sem permissão para rever documentos.'}});
    const orderId=clean(req.params.orderId,80),documentId=clean(req.params.documentId,80);
    const status=clean(req.body?.status,40).toUpperCase();
    const reviewNotes=clean(req.body?.reviewNotes,4000)||null;
    if(!REVIEW_STATUSES.has(status))return res.status(400).json({success:false,error:{code:'BAD_REQUEST',message:'Estado inválido.'}});
    const before=await prisma.$queryRaw<any[]>`select * from service_order_documents where id=cast(${documentId} as uuid) and service_order_id=cast(${orderId} as uuid) limit 1`;
    if(!before[0])return res.status(404).json({success:false,error:{code:'NOT_FOUND',message:'Documento não encontrado.'}});
    const rows=await prisma.$queryRaw<any[]>`
      update service_order_documents set status=${status},review_notes=${reviewNotes},reviewed_by_merchant_id=cast(${m.merchant_id} as uuid),reviewed_at=now(),updated_at=now()
      where id=cast(${documentId} as uuid) returning *
    `;
    if(before[0].requirement_id){
      const requirementStatus=status==='APPROVED'?'APPROVED':status==='REJECTED'?'REJECTED':'SUBMITTED';
      await prisma.$executeRaw`update service_order_requirements set status=${requirementStatus},updated_at=now() where id=cast(${before[0].requirement_id} as uuid)`;
    }
    await audit(String(m.merchant_id),'DOCUMENT_REVIEWED',orderId,before[0],rows[0],{documentId,status});
    return res.json({success:true,data:{document:rows[0]}});
  }catch(error:any){
    console.error('[expert-ops.document.review]',error?.message||error);
    return res.status(500).json({success:false,error:{code:'SERVER_ERROR',message:'Não foi possível rever o documento.'}});
  }
};

export const updateRequirement=async(req:AuthRequest,res:Response)=>{
  try{
    const m=await member(req,'expert_orders_write');
    if(!m)return res.status(403).json({success:false,error:{code:'FORBIDDEN',message:'Sem permissão para atualizar requisitos.'}});
    const orderId=clean(req.params.orderId,80),code=clean(req.params.requirementCode,120).toUpperCase();
    const status=clean(req.body?.status,40).toUpperCase();
    const notes=clean(req.body?.notes,4000)||null;
    if(!REQUIREMENT_STATUSES.has(status))return res.status(400).json({success:false,error:{code:'BAD_REQUEST',message:'Estado inválido.'}});
    const before=await prisma.$queryRaw<any[]>`select * from service_order_requirements where service_order_id=cast(${orderId} as uuid) and code=${code} limit 1`;
    if(!before[0])return res.status(404).json({success:false,error:{code:'NOT_FOUND',message:'Requisito não encontrado.'}});
    const rows=await prisma.$queryRaw<any[]>`update service_order_requirements set status=${status},notes=coalesce(${notes},notes),updated_at=now() where id=cast(${before[0].id} as uuid) returning *`;
    await audit(String(m.merchant_id),'REQUIREMENT_UPDATED',orderId,before[0],rows[0],{code,status});
    return res.json({success:true,data:{requirement:rows[0]}});
  }catch(error:any){
    console.error('[expert-ops.requirement.update]',error?.message||error);
    return res.status(500).json({success:false,error:{code:'SERVER_ERROR',message:'Não foi possível atualizar o requisito.'}});
  }
};
