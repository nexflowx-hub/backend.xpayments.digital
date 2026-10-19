BEGIN;

DO $$
DECLARE
  v_merchant uuid;
  v_count integer;
  v_total numeric(18,2);
  v_center uuid;
  v_cost uuid;
  v_plan uuid;
  v_fx numeric(24,10);
  v_fx_date date;
BEGIN
  SELECT MIN(merchant_id), COUNT(*), SUM(amount)
  INTO v_merchant, v_count, v_total
  FROM public.payout_statements
  WHERE external_reference IN (
    'ADV-REVEURO2-20260730-46312',
    'ADV-REVEURO1-20260730-66951',
    'D0-20260729-REVEURO1-58711',
    'D0-20260729-REVEURO1-133373'
  ) AND status='paid' AND upper(currency)='EUR';

  IF v_count<>4 THEN RAISE EXCEPTION 'Piloto requer 4 payouts EUR pagos; encontrados %',v_count; END IF;
  IF v_total<>3053.47 THEN RAISE EXCEPTION 'Total divergente: esperado 3053.47, encontrado %',v_total; END IF;
  IF (SELECT COUNT(DISTINCT merchant_id) FROM public.payout_statements WHERE external_reference IN (
    'ADV-REVEURO2-20260730-46312','ADV-REVEURO1-20260730-66951','D0-20260729-REVEURO1-58711','D0-20260729-REVEURO1-133373'
  ))<>1 THEN RAISE EXCEPTION 'Os payouts não pertencem ao mesmo merchant'; END IF;

  INSERT INTO public.finance_cost_centers (merchant_id,code,name,description,status,created_by,metadata)
  VALUES (v_merchant,'TRAFFIC-PAID','Tráfego Pago','Aquisição paga e reinvestimento operacional.','active','pilot-20260729','{"pilot":true}'::jsonb)
  ON CONFLICT (merchant_id,code) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,status='active',metadata=public.finance_cost_centers.metadata||EXCLUDED.metadata
  RETURNING id INTO v_center;

  INSERT INTO public.finance_cost_entries (
    merchant_id,cost_center_id,category,description,amount,currency,competence_date,paid_on,status,source,
    external_reference,idempotency_key,created_by,approved_by,approved_at,metadata
  ) VALUES (
    v_merchant,v_center,'traffic_paid','Tráfego pago deduzido antes do split do ciclo de 29/07/2026.',964.00,'EUR',DATE '2026-07-29',DATE '2026-07-29','paid','manual',
    'TRAFFIC-20260729-96400','pilot:20260729:traffic-paid:96400','pilot-20260729','pilot-20260729',now(),
    '{"pilot":true,"allocationStatus":"merchant_shared"}'::jsonb
  )
  ON CONFLICT (merchant_id,idempotency_key) WHERE idempotency_key IS NOT NULL
  DO UPDATE SET cost_center_id=EXCLUDED.cost_center_id,amount=964.00,status='paid',paid_on=DATE '2026-07-29',metadata=public.finance_cost_entries.metadata||EXCLUDED.metadata
  RETURNING id INTO v_cost;

  SELECT rate,rate_date INTO v_fx,v_fx_date FROM public.finance_fx_rates
  WHERE base_currency='EUR' AND quote_currency='BRL' ORDER BY rate_date DESC,created_at DESC LIMIT 1;

  INSERT INTO public.finance_distribution_plans (
    plan_code,merchant_id,currency,period_start,period_end,source_total,cost_total,reserve_total,distributable_total,allocated_total,
    status,residual_policy,reporting_currency,reporting_rate,reporting_source,reporting_rate_date,created_by,approved_by,approved_at,reconciled_at,metadata
  ) VALUES (
    'DIST-20260729-REVEURO-001',v_merchant,'EUR',DATE '2026-07-29',DATE '2026-07-29',3053.47,964.00,0.00,2089.47,2089.47,
    'reconciled','last_allocation',CASE WHEN v_fx IS NULL THEN NULL ELSE 'BRL' END,v_fx,CASE WHEN v_fx IS NULL THEN NULL ELSE 'BCB_PTAX' END,v_fx_date,
    'pilot-20260729','pilot-20260729',now(),now(),'{"pilot":true,"roundingRule":"residual_to_salaries"}'::jsonb
  )
  ON CONFLICT (plan_code) DO UPDATE SET source_total=3053.47,cost_total=964.00,reserve_total=0.00,distributable_total=2089.47,allocated_total=2089.47,status='reconciled',
    reporting_currency=EXCLUDED.reporting_currency,reporting_rate=EXCLUDED.reporting_rate,reporting_source=EXCLUDED.reporting_source,reporting_rate_date=EXCLUDED.reporting_rate_date,
    metadata=public.finance_distribution_plans.metadata||EXCLUDED.metadata
  RETURNING id INTO v_plan;

  INSERT INTO public.finance_distribution_sources (distribution_plan_id,payout_statement_id,amount,source_reference,metadata)
  SELECT v_plan,id,amount,external_reference,jsonb_build_object('statementCode',statement_code,'paidOn',paid_on)
  FROM public.payout_statements WHERE external_reference IN (
    'ADV-REVEURO2-20260730-46312','ADV-REVEURO1-20260730-66951','D0-20260729-REVEURO1-58711','D0-20260729-REVEURO1-133373'
  )
  ON CONFLICT (distribution_plan_id,payout_statement_id) DO UPDATE SET amount=EXCLUDED.amount,source_reference=EXCLUDED.source_reference,metadata=EXCLUDED.metadata;

  INSERT INTO public.finance_distribution_costs (distribution_plan_id,cost_entry_id,amount,metadata)
  VALUES (v_plan,v_cost,964.00,'{"deductionOrder":1}'::jsonb)
  ON CONFLICT (distribution_plan_id,cost_entry_id) DO UPDATE SET amount=964.00;

  INSERT INTO public.finance_distribution_allocations (
    distribution_plan_id,beneficiary_code,beneficiary_name,allocation_type,percentage,amount,is_residual,status,metadata
  ) VALUES
    (v_plan,'PARTNER-S','Partner S','percentage',25.000000,522.37,false,'paid','{"order":1}'::jsonb),
    (v_plan,'PARTNER-W','Partner W','percentage',25.000000,522.37,false,'paid','{"order":2}'::jsonb),
    (v_plan,'PARTNER-F','Partner F','percentage',25.000000,522.37,false,'paid','{"order":3}'::jsonb),
    (v_plan,'SALARIES','Salários','residual',25.000000,522.36,true,'paid','{"order":4,"roundingResidual":-0.01}'::jsonb)
  ON CONFLICT (distribution_plan_id,beneficiary_code) DO UPDATE SET beneficiary_name=EXCLUDED.beneficiary_name,allocation_type=EXCLUDED.allocation_type,
    percentage=EXCLUDED.percentage,amount=EXCLUDED.amount,is_residual=EXCLUDED.is_residual,status=EXCLUDED.status,metadata=EXCLUDED.metadata;

  IF (SELECT COALESCE(SUM(amount),0) FROM public.finance_distribution_allocations WHERE distribution_plan_id=v_plan AND status<>'cancelled')<>2089.47
    THEN RAISE EXCEPTION 'Soma das alocações divergente'; END IF;

  INSERT INTO public.finance_operation_events (merchant_id,entity_type,entity_id,event_type,actor_reference,payload)
  SELECT v_merchant,'distribution_plan',v_plan,'pilot_reconciled','pilot-20260729','{"sourceTotal":3053.47,"costTotal":964.00,"distributableTotal":2089.47,"allocations":4}'::jsonb
  WHERE NOT EXISTS (SELECT 1 FROM public.finance_operation_events WHERE entity_type='distribution_plan' AND entity_id=v_plan AND event_type='pilot_reconciled');
END
$$;

COMMIT;
