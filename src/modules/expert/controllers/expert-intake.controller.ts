import { Response } from 'express';
import prisma from '../../../core/prisma';
import { AuthRequest } from '../../../middleware/auth.middleware';

const merchantIdFrom = (req: AuthRequest) => String(req.merchantId || req.user?.id || '').trim();
const clean = (value: unknown, max = 2000) => String(value ?? '').trim().slice(0, max);

async function ownedOrder(orderId: string, merchantId: string) {
  const rows = await prisma.$queryRaw<any[]>`
    select id, order_code, payment_status, payment_currency
    from service_orders
    where id=cast(${orderId} as uuid) and merchant_id=cast(${merchantId} as uuid)
    limit 1
  `;
  return rows[0] || null;
}

export const listOrderIntake = async (req: AuthRequest, res: Response) => {
  try {
    const merchantId = merchantIdFrom(req);
    const orderId = clean(req.params.orderId, 80);
    if (!merchantId) return res.status(401).json({success:false,error:{code:'UNAUTHORIZED',message:'Autenticação necessária.'}});
    const order = await ownedOrder(orderId, merchantId);
    if (!order) return res.status(404).json({success:false,error:{code:'NOT_FOUND',message:'Contratação não encontrada.'}});

    const requirements = await prisma.$queryRaw<any[]>`
      select id, code, label, required, status, notes, metadata, created_at, updated_at
      from service_order_requirements
      where service_order_id=cast(${orderId} as uuid)
      order by created_at, code
    `;
    const documents = await prisma.$queryRaw<any[]>`
      select id, requirement_id, category, label, original_name, mime_type, file_size,
             external_url, status, review_notes, metadata, created_at, updated_at
      from service_order_documents
      where service_order_id=cast(${orderId} as uuid)
      order by created_at desc
    `;
    const proofs = await prisma.$queryRaw<any[]>`
      select id, payment_method, payment_reference, external_url, note, status,
             review_notes, metadata, created_at, updated_at
      from service_order_payment_proofs
      where service_order_id=cast(${orderId} as uuid)
      order by created_at desc
    `;

    return res.json({success:true,data:{order:{id:order.id,orderCode:order.order_code,paymentStatus:order.payment_status,paymentCurrency:order.payment_currency},requirements:requirements.map(r=>({id:r.id,code:r.code,label:r.label,required:r.required,status:r.status,notes:r.notes,metadata:r.metadata||{},createdAt:r.created_at,updatedAt:r.updated_at})),documents:documents.map(d=>({id:d.id,requirementId:d.requirement_id,category:d.category,label:d.label,originalName:d.original_name,mimeType:d.mime_type,fileSize:d.file_size==null?null:Number(d.file_size),externalUrl:d.external_url,status:d.status,reviewNotes:d.review_notes,metadata:d.metadata||{},createdAt:d.created_at,updatedAt:d.updated_at})),paymentProofs:proofs.map(p=>({id:p.id,paymentMethod:p.payment_method,paymentReference:p.payment_reference,externalUrl:p.external_url,note:p.note,status:p.status,reviewNotes:p.review_notes,metadata:p.metadata||{},createdAt:p.created_at,updatedAt:p.updated_at}))}});
  } catch (error:any) {
    console.error('[expert.intake.list]',error?.message||error);
    return res.status(500).json({success:false,error:{code:'SERVER_ERROR',message:'Não foi possível carregar os dados do pedido.'}});
  }
};

export const submitPaymentProof = async (req: AuthRequest, res: Response) => {
  try {
    const merchantId = merchantIdFrom(req);
    const orderId = clean(req.params.orderId,80);
    if (!merchantId) return res.status(401).json({success:false,error:{code:'UNAUTHORIZED',message:'Autenticação necessária.'}});
    const order = await ownedOrder(orderId, merchantId);
    if (!order) return res.status(404).json({success:false,error:{code:'NOT_FOUND',message:'Contratação não encontrada.'}});

    const paymentMethod = clean(req.body?.paymentMethod,80).toUpperCase() || clean(order.payment_currency,20).toUpperCase();
    const paymentReference = clean(req.body?.paymentReference,300) || clean(order.order_code,100);
    const externalUrl = clean(req.body?.externalUrl,2000) || null;
    const note = clean(req.body?.note,4000) || null;
    const metadata = req.body?.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : {};

    const rows = await prisma.$queryRaw<any[]>`
      insert into service_order_payment_proofs(
        service_order_id,payment_method,payment_reference,external_url,note,status,submitted_by_merchant_id,metadata
      ) values(
        cast(${orderId} as uuid),${paymentMethod},${paymentReference},${externalUrl},${note},'SUBMITTED',cast(${merchantId} as uuid),${JSON.stringify(metadata)}::jsonb
      ) returning id,payment_method,payment_reference,external_url,note,status,created_at
    `;

    return res.status(201).json({success:true,data:{proof:{id:rows[0].id,paymentMethod:rows[0].payment_method,paymentReference:rows[0].payment_reference,externalUrl:rows[0].external_url,note:rows[0].note,status:rows[0].status,createdAt:rows[0].created_at}}});
  } catch (error:any) {
    console.error('[expert.proof.submit]',error?.message||error);
    return res.status(500).json({success:false,error:{code:'SERVER_ERROR',message:'Não foi possível registar o comprovativo.'}});
  }
};

export const registerOrderDocument = async (req: AuthRequest, res: Response) => {
  try {
    const merchantId = merchantIdFrom(req);
    const orderId = clean(req.params.orderId,80);
    if (!merchantId) return res.status(401).json({success:false,error:{code:'UNAUTHORIZED',message:'Autenticação necessária.'}});
    const order = await ownedOrder(orderId, merchantId);
    if (!order) return res.status(404).json({success:false,error:{code:'NOT_FOUND',message:'Contratação não encontrada.'}});

    const requirementCode = clean(req.body?.requirementCode,120).toUpperCase();
    const category = clean(req.body?.category,120).toUpperCase() || 'OTHER';
    const label = clean(req.body?.label,300) || null;
    const originalName = clean(req.body?.originalName,500) || null;
    const mimeType = clean(req.body?.mimeType,200) || null;
    const fileSize = Number(req.body?.fileSize || 0) || null;
    const externalUrl = clean(req.body?.externalUrl,2000) || null;
    const metadata = req.body?.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : {};

    let requirementId:string|null=null;
    if(requirementCode){
      const reqRows=await prisma.$queryRaw<any[]>`
        select id from service_order_requirements
        where service_order_id=cast(${orderId} as uuid) and code=${requirementCode}
        limit 1
      `;
      requirementId=reqRows[0]?.id||null;
    }

    const rows=await prisma.$queryRaw<any[]>`
      insert into service_order_documents(
        service_order_id,requirement_id,category,label,original_name,mime_type,file_size,external_url,status,submitted_by_merchant_id,metadata
      ) values(
        cast(${orderId} as uuid),${requirementId}::uuid,${category},${label},${originalName},${mimeType},${fileSize},${externalUrl},'SUBMITTED',cast(${merchantId} as uuid),${JSON.stringify(metadata)}::jsonb
      ) returning id,requirement_id,category,label,original_name,mime_type,file_size,external_url,status,created_at
    `;

    if(requirementId){
      await prisma.$executeRaw`update service_order_requirements set status='SUBMITTED',updated_at=now() where id=cast(${requirementId} as uuid)`;
    }

    return res.status(201).json({success:true,data:{document:{id:rows[0].id,requirementId:rows[0].requirement_id,category:rows[0].category,label:rows[0].label,originalName:rows[0].original_name,mimeType:rows[0].mime_type,fileSize:rows[0].file_size==null?null:Number(rows[0].file_size),externalUrl:rows[0].external_url,status:rows[0].status,createdAt:rows[0].created_at}}});
  } catch(error:any){
    console.error('[expert.document.register]',error?.message||error);
    return res.status(500).json({success:false,error:{code:'SERVER_ERROR',message:'Não foi possível registar o documento.'}});
  }
};
