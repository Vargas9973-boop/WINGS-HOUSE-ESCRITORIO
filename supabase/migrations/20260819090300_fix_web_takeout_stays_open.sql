-- BUG REAL (confirmado leyendo wing-house-web/src/components/comandas.jsx y
-- el process_sale vigente en 20260816010000_process_sale_delivery_open.sql,
-- no se adivinó): un pedido "PARA LLEVAR" hecho desde la web SIN marcar "a
-- domicilio" llama a process_sale con p_client_type='Llevar' y
-- p_is_delivery=false. 20260816010000 ya había resuelto exactamente este
-- mismo bug para domicilio (la venta nacía 'completada' y getOpenTakeoutOrders
-- -- que solo lista status='abierta' -- nunca la mostraba, aunque la
-- notificación de escritorio sí llegaba porque esa escucha no filtra
-- status), pero la condición que decide v_status solo miraba p_is_delivery.
-- Un "para llevar" sin domicilio caía en el mismo hueco: se insertaba
-- 'completada' de una vez, invisible en Comandas, aunque ya estaba pagada
-- (el pago se captura en el mismo llamado a process_sale) y cocina nunca
-- se enteraba de prepararla.
--
-- MESA no usa process_sale (abre con open_table/comanda_open_table,
-- siempre 'abierta') y DOMICILIO ya estaba resuelto -- por eso el reporte
-- "mesa y domicilio sí funcionan, para llevar no" cuadra exacto con este
-- hueco.
--
-- Fix (mismo patrón, una sola línea de más): también se queda 'abierta'
-- cuando p_client_type='Llevar', sin importar is_delivery. Firma sin
-- cambios -- no hace falta DROP FUNCTION, solo reemplazar el cuerpo.
CREATE OR REPLACE FUNCTION public.process_sale(
  p_client_type text,
  p_items jsonb,
  p_payment_method text,
  p_amount_received numeric,
  p_discount numeric,
  p_opened_by text,
  p_employee_id bigint DEFAULT NULL::bigint,
  p_employee_sale_type text DEFAULT NULL::text,
  p_employee_extra_payment text DEFAULT NULL::text,
  p_is_delivery boolean DEFAULT false
) RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$

DECLARE
    v_sale_id bigint;
    v_folio text;

    v_total numeric := 0;
    v_item jsonb;
    v_item_total numeric := 0;
    v_current_stock numeric;
    v_employee_name text;

    -- ================================================================
    -- CONSUMO / BENEFICIO DEL EMPLEADO
    -- ================================================================

    v_today date;
    v_today_consumed numeric := 0;
    v_benefit_available numeric := 100;

    v_benefit_amount numeric := 0;
    v_employee_paid numeric := 0;
    v_credit_amount numeric := 0;
    v_extra_amount numeric := 0;

    -- Valores restantes para repartir entre artículos
    v_benefit_remaining numeric := 0;
    v_paid_remaining numeric := 0;
    v_credit_remaining numeric := 0;

    v_item_benefit numeric := 0;
    v_item_paid numeric := 0;
    v_item_credit numeric := 0;

    v_week_start date;

    -- Snapshot para el ticket (solo aplica si p_client_type = 'employee')
    v_benefit_before_out numeric := NULL;
    v_benefit_after_out numeric := NULL;

    -- Estado de la venta: 'abierta' si es domicilio o "para llevar" desde
    -- la web (se cierra hasta que comandaSetDeliveryStatus/el KDS la marcan
    -- entregada), 'completada' en cualquier otro caso, igual que siempre.
    v_status text := 'completada';

BEGIN

    -- ================================================================
    -- FECHA ACTUAL DE MÉXICO
    -- ================================================================

    v_today :=
        (now() AT TIME ZONE 'America/Mexico_City')::date;


    -- ================================================================
    -- VALIDAR ARTÍCULOS
    -- ================================================================

    IF p_items IS NULL
       OR jsonb_array_length(p_items) = 0
    THEN
        RAISE EXCEPTION 'La venta no contiene artículos.';
    END IF;


    -- ================================================================
    -- VALIDAR VENTA DE EMPLEADO
    -- ================================================================

    IF p_client_type = 'employee'
       AND p_employee_id IS NULL
    THEN
        RAISE EXCEPTION
            'La venta de empleado requiere seleccionar un empleado.';
    END IF;


    -- ================================================================
    -- OBTENER EMPLEADO
    -- ================================================================

    IF p_employee_id IS NOT NULL THEN

        SELECT name
        INTO v_employee_name
        FROM public.employees
        WHERE id = p_employee_id
          AND active = true;

        IF v_employee_name IS NULL THEN
            RAISE EXCEPTION
                'El empleado seleccionado no existe o está inactivo.';
        END IF;

    END IF;


    -- ================================================================
    -- BLOQUEAR EL EMPLEADO DURANTE LA TRANSACCIÓN
    -- EVITA QUE DOS VENTAS SIMULTÁNEAS SUPEREN LOS $100
    -- ================================================================

    IF p_client_type = 'employee'
       AND p_employee_sale_type = 'daily_100'
    THEN

        PERFORM pg_advisory_xact_lock(
            hashtext(
                'employee_daily_benefit_' ||
                p_employee_id::text
            )
        );

    END IF;


    -- ================================================================
    -- CALCULAR TOTAL DE LOS ARTÍCULOS
    -- ================================================================

    FOR v_item IN
        SELECT *
        FROM jsonb_array_elements(p_items)
    LOOP

        -- ------------------------------------------------------------
        -- VALIDAR INVENTARIO
        -- ------------------------------------------------------------

        IF COALESCE(
            v_item->>'item_type',
            'product'
        ) = 'product'

        AND NULLIF(
            v_item->>'ref_id',
            ''
        ) IS NOT NULL
        THEN

            SELECT stock
            INTO v_current_stock
            FROM public.products
            WHERE id = (v_item->>'ref_id')::bigint;

            IF v_current_stock IS NOT NULL
               AND v_current_stock <
                   (v_item->>'quantity')::numeric
            THEN

                RAISE EXCEPTION
                    '"%" no tiene existencia disponible.',
                    v_item->>'name';

            END IF;

        END IF;


        -- ------------------------------------------------------------
        -- TOTAL DEL ARTÍCULO
        -- ------------------------------------------------------------

        v_item_total :=
            ROUND(
                (v_item->>'unit_price')::numeric
                *
                (v_item->>'quantity')::numeric,
                2
            );

        v_total :=
            v_total + v_item_total;

    END LOOP;


    -- ================================================================
    -- FIX: v_total YA VIENE CALCULADO CON EL PRECIO FINAL POR ARTÍCULO
    -- (unit_price ya incluye el descuento de empleado cuando aplica).
    -- p_discount es solo informativo para el ticket -- NO debe restarse
    -- aquí de nuevo, o se descuenta dos veces.
    -- ================================================================

    v_total :=
        ROUND(
            GREATEST(
                v_total,
                0
            ),
            2
        );


    -- ================================================================
    -- CALCULAR BENEFICIO DEL EMPLEADO
    -- ================================================================

    IF p_client_type = 'employee' THEN

        -- ------------------------------------------------------------
        -- CONSUMO REAL DEL DÍA
        -- ------------------------------------------------------------

        SELECT COALESCE(
            SUM(
                ROUND(
                    COALESCE(benefit_amount, 0),
                    2
                )
            ),
            0
        )
        INTO v_today_consumed
        FROM public.employee_consumption
        WHERE employee_id = p_employee_id
          AND consumption_date = v_today;


        -- ------------------------------------------------------------
        -- DISPONIBLE REAL
        -- ------------------------------------------------------------

        v_benefit_available :=
            ROUND(
                GREATEST(
                    100 - v_today_consumed,
                    0
                ),
                2
            );


        -- ============================================================
        -- CONSUMO DIARIO $100
        -- ============================================================

        IF p_employee_sale_type = 'daily_100' THEN

            -- --------------------------------------------------------
            -- EL BENEFICIO SE CALCULA SOBRE EL TOTAL DE LA VENTA
            -- Y NO PRODUCTO POR PRODUCTO.
            --
            -- Ejemplo:
            --
            -- Disponible: $100
            -- Venta:      $83
            --
            -- Beneficio:  $83
            -- Crédito:    $0
            --
            -- Si disponible = $17:
            --
            -- Venta:      $30
            -- Beneficio:  $17
            -- Crédito:    $13
            -- --------------------------------------------------------

            v_benefit_amount :=
                ROUND(
                    LEAST(
                        v_total,
                        v_benefit_available
                    ),
                    2
                );


            -- --------------------------------------------------------
            -- EXCEDENTE
            -- --------------------------------------------------------

            v_extra_amount :=
                ROUND(
                    GREATEST(
                        v_total - v_benefit_amount,
                        0
                    ),
                    2
                );


            -- --------------------------------------------------------
            -- SI EXISTE EXCEDENTE, DETERMINAR FORMA DE PAGO
            -- --------------------------------------------------------

            IF v_extra_amount > 0 THEN

                IF p_employee_extra_payment
                   NOT IN ('cash', 'credit')
                THEN

                    RAISE EXCEPTION
                        'La venta excede el beneficio disponible. Selecciona Efectivo o Crédito para el excedente.';

                END IF;


                IF p_employee_extra_payment = 'cash' THEN

                    v_employee_paid :=
                        v_extra_amount;

                ELSE

                    v_credit_amount :=
                        v_extra_amount;

                END IF;

            END IF;


        -- ============================================================
        -- PARA LLEVAR / CRÉDITO
        -- ============================================================

        ELSIF p_employee_sale_type = 'takeaway_credit' THEN

            v_benefit_amount := 0;
            v_credit_amount := v_total;


        ELSE

            RAISE EXCEPTION
                'Tipo de consumo de empleado no válido.';

        END IF;

    END IF;


    -- ================================================================
    -- REDONDEAR VALORES FINALES
    -- ================================================================

    v_benefit_amount :=
        ROUND(
            COALESCE(v_benefit_amount, 0),
            2
        );

    v_employee_paid :=
        ROUND(
            COALESCE(v_employee_paid, 0),
            2
        );

    v_credit_amount :=
        ROUND(
            COALESCE(v_credit_amount, 0),
            2
        );


    -- ================================================================
    -- SNAPSHOT DE BENEFICIO PARA EL TICKET (antes/después de esta venta)
    -- ================================================================

    IF p_client_type = 'employee' THEN
        v_benefit_before_out := v_benefit_available;
        v_benefit_after_out := GREATEST(v_benefit_available - v_benefit_amount, 0);
    END IF;


    -- ================================================================
    -- PREPARAR VALORES PARA REPARTIR POR ARTÍCULO
    -- ================================================================

    v_benefit_remaining := v_benefit_amount;
    v_paid_remaining := v_employee_paid;
    v_credit_remaining := v_credit_amount;


    -- ================================================================
    -- GENERAR FOLIO
    -- ================================================================

    v_folio := public.wh_next_folio();


    -- ================================================================
    -- ESTADO DE LA VENTA
    -- Un pedido a domicilio, o "para llevar" pedido desde la web
    -- (client_type='Llevar', ya viene pagado), se queda 'abierta' (visible
    -- en comandas/KDS) hasta que el escritorio lo marca entregado --
    -- comandaSetDeliveryStatus para domicilio, el botón ENTREGAR del KDS
    -- para "para llevar" (ver updateKdsStatus en db.js).
    -- ================================================================

    IF p_is_delivery OR p_client_type = 'Llevar' THEN
        v_status := 'abierta';
    END IF;


    -- ================================================================
    -- CREAR VENTA
    -- ================================================================

    INSERT INTO public.sales (
        folio,
        client_type,
        employee_id,
        employee_name,
        employee_sale_type,
        payment_method,
        amount_received,
        total,
        status,
        table_number,
        opened_by,
        employee_benefit_before,
        employee_benefit_after
    )
    VALUES (
        v_folio,
        p_client_type,
        p_employee_id,
        v_employee_name,
        p_employee_sale_type,
        p_payment_method,
        p_amount_received,
        v_total,
        v_status,
        NULL,
        p_opened_by,
        v_benefit_before_out,
        v_benefit_after_out
    )
    RETURNING id INTO v_sale_id;


    -- ================================================================
    -- CREAR DETALLES + INVENTARIO + CONSUMO
    -- ================================================================

    FOR v_item IN
        SELECT *
        FROM jsonb_array_elements(p_items)
    LOOP

        -- ------------------------------------------------------------
        -- TOTAL DEL ARTÍCULO
        -- ------------------------------------------------------------

        v_item_total :=
            ROUND(
                (v_item->>'unit_price')::numeric
                *
                (v_item->>'quantity')::numeric,
                2
            );


        -- ============================================================
        -- SALE ITEMS
        -- ============================================================

        INSERT INTO public.sale_items (
            sale_id,
            ref_id,
            item_type,
            name,
            unit_price,
            quantity,
            subtotal
        )
        VALUES (
            v_sale_id,
            NULLIF(
                v_item->>'ref_id',
                ''
            )::bigint,

            COALESCE(
                v_item->>'item_type',
                'product'
            ),

            v_item->>'name',

            ROUND(
                (v_item->>'unit_price')::numeric,
                2
            ),

            (v_item->>'quantity')::int,

            v_item_total
        );


        -- ============================================================
        -- DESCONTAR INVENTARIO
        -- ============================================================

        IF COALESCE(
            v_item->>'item_type',
            'product'
        ) = 'product'

        AND NULLIF(
            v_item->>'ref_id',
            ''
        ) IS NOT NULL
        THEN

            UPDATE public.products
            SET stock =
                GREATEST(
                    stock -
                    (v_item->>'quantity')::numeric,
                    0
                )
            WHERE id =
                (v_item->>'ref_id')::bigint

              AND stock IS NOT NULL;

        END IF;


        -- ============================================================
        -- CONSUMO DEL EMPLEADO
        -- ============================================================

        IF p_client_type = 'employee' THEN

            -- --------------------------------------------------------
            -- BENEFICIO DEL ARTÍCULO
            --
            -- IMPORTANTE:
            -- Se reparte el beneficio TOTAL de la venta.
            -- Ya NO se recalcula el límite de $100 por artículo.
            -- --------------------------------------------------------

            IF v_benefit_remaining > 0 THEN

                v_item_benefit :=
                    ROUND(
                        LEAST(
                            v_item_total,
                            v_benefit_remaining
                        ),
                        2
                    );

            ELSE

                v_item_benefit := 0;

            END IF;


            -- --------------------------------------------------------
            -- EFECTIVO DEL ARTÍCULO
            -- --------------------------------------------------------

            IF v_paid_remaining > 0 THEN

                v_item_paid :=
                    ROUND(
                        LEAST(
                            GREATEST(
                                v_item_total -
                                v_item_benefit,
                                0
                            ),
                            v_paid_remaining
                        ),
                        2
                    );

            ELSE

                v_item_paid := 0;

            END IF;


            -- --------------------------------------------------------
            -- CRÉDITO DEL ARTÍCULO
            -- --------------------------------------------------------

            v_item_credit :=
                ROUND(
                    GREATEST(
                        v_item_total -
                        v_item_benefit -
                        v_item_paid,
                        0
                    ),
                    2
                );


            -- --------------------------------------------------------
            -- ACTUALIZAR RESTANTES
            -- --------------------------------------------------------

            v_benefit_remaining :=
                ROUND(
                    GREATEST(
                        v_benefit_remaining -
                        v_item_benefit,
                        0
                    ),
                    2
                );


            v_paid_remaining :=
                ROUND(
                    GREATEST(
                        v_paid_remaining -
                        v_item_paid,
                        0
                    ),
                    2
                );


            v_credit_remaining :=
                ROUND(
                    GREATEST(
                        v_credit_remaining -
                        v_item_credit,
                        0
                    ),
                    2
                );


            -- ========================================================
            -- INSERTAR CONSUMO
            -- ========================================================

            INSERT INTO public.employee_consumption (
                employee_id,
                employee_name,
                sale_id,
                consumption_date,
                item_name,
                item_type,
                quantity,
                unit_price,
                total_amount,
                benefit_amount,
                employee_paid,
                payment_method,
                is_credit,
                credit_week_start
            )
            VALUES (
                p_employee_id,
                v_employee_name,
                v_sale_id,
                v_today,
                v_item->>'name',

                COALESCE(
                    v_item->>'item_type',
                    'product'
                ),

                (v_item->>'quantity')::numeric,

                ROUND(
                    (v_item->>'unit_price')::numeric,
                    2
                ),

                v_item_total,

                v_item_benefit,

                v_item_paid,

                CASE
                    WHEN v_item_credit > 0
                        THEN 'credito'

                    WHEN v_item_paid > 0
                        THEN 'efectivo'

                    ELSE 'beneficio'
                END,

                v_item_credit > 0,

                CASE
                    WHEN v_item_credit > 0
                    THEN date_trunc(
                        'week',
                        v_today
                    )::date

                    ELSE NULL
                END
            );

        END IF;

    END LOOP;


    -- ================================================================
    -- CRÉDITO SEMANAL
    -- ================================================================

    IF p_client_type = 'employee'
       AND (
           v_credit_amount > 0
           OR v_benefit_amount > 0
       )
    THEN

        v_week_start :=
            date_trunc(
                'week',
                v_today
            )::date;


        INSERT INTO public.employee_weekly_credit (
            employee_id,
            employee_name,
            week_start,
            benefit_used,
            credit_amount,
            paid_amount,
            payroll_deducted
        )
        VALUES (
            p_employee_id,
            v_employee_name,
            v_week_start,
            v_benefit_amount,
            v_credit_amount,
            v_employee_paid,
            false
        )

        ON CONFLICT (
            employee_id,
            week_start
        )

        DO UPDATE SET

            benefit_used =
                public.employee_weekly_credit.benefit_used
                +
                EXCLUDED.benefit_used,

            credit_amount =
                public.employee_weekly_credit.credit_amount
                +
                EXCLUDED.credit_amount,

            paid_amount =
                public.employee_weekly_credit.paid_amount
                +
                EXCLUDED.paid_amount,

            updated_at = now();

    END IF;


    -- ================================================================
    -- RESPUESTA
    -- ================================================================

    RETURN json_build_object(

        'id',
        v_sale_id,

        'folio',
        v_folio,

        'employee_id',
        p_employee_id,

        'employee_name',
        v_employee_name,

        'employee_sale_type',
        p_employee_sale_type,

        'total',
        v_total,

        'benefit_used',
        v_benefit_amount,

        'employee_paid',
        v_employee_paid,

        'credit_amount',
        v_credit_amount,

        'benefit_available_before',
        v_benefit_available,

        'benefit_available_after',
        GREATEST(
            v_benefit_available -
            v_benefit_amount,
            0
        )

    );

END;

$function$;
