import { Response } from 'express';
import prisma from '../../../core/prisma';
import { AuthRequest } from '../../../middleware/auth.middleware';

const actorId=(req:AuthRequest)=>String(req.merchantId||req.user?.id||'').trim();

async function allowed(req:AuthRequest){
  const actor=actorId(req); if(!actor)return false;
  const rows=await prisma.$queryRaw<any[]>`
    select role,permissions from expert_ops_members
    where merchant_id=cast(${actor} as uuid) and active=true limit 1
  `;
  const m=rows[0]; if(!m)return false;
  const permissions=Array.isArray(m.permissions)?m.permissions:[];
  return m.role==='admin'||permissions.includes('expert_orders_read');
}

export const listIntakeQueue=async(req:AuthRequest,res:Response)=>{
  try{
    if(!(await allowed(req)))return res.status(403).json({success:false,error:{code:'FORBIDDEN',message:'Sem acesso à fila de intake.'}});
    const status=String(req.query.status||'SUBMITTED').trim().toUpperCase();
    const proofs=await prisma.$queryRawUnsafe<any[]>(`
      select p.id,p.service_order_id,p.payment_method,p.payment_reference,p.external_url,p.note,p.status,p.review_notes,p.created_at,
             so.order_code,m.name as merchant_name,m.email as merchant_email,off.name as offering_name
      from service_order_payment_proofs p
      join service_orders so on so.id=p.service_order_id
      join merchants m on m.id=so.merchant_id
      join service_offerings off on off.id=so.offering_id
      where ($1='' or p.status=$1)
      order by p.created_at desc limit 300
    `,status);
    const documents=await prisma.$queryRawUnsafe<any[]>(`
      select d.id,d.service_order_id,d.requirement_id,d.category,d.label,d.original_name,d.mime_type,d.file_size,d.external_url,d.status,d.review_notes,d.created_at,
             so.order_code,m.name as merchant_name,m.email as merchant_email,off.name as offering_name,r.label as requirement_label
      from service_order_documents d
      join service_orders so on so.id=d.service_order_id
      join merchants m on m.id=so.merchant_id
      join service_offerings off on off.id=so.offering_id
      left join service_order_requirements r on r.id=d.requirement_id
      where ($1='' or d.status=$1)
      order by d.created_at desc limit 300
    `,status);
    return res.json({success:true,data:{paymentProofs:proofs,documents}});
  }catch(error:any){
    console.error('[expert-ops.intake.queue]',error?.message||error);
    return res.status(500).json({success:false,error:{code:'SERVER_ERROR',message:'Não foi possível carregar a fila de intake.'}});
  }
};
