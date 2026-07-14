XPayments API Contract v3.1
Merchant Platform
Base URL
DEV

https://api.xpayments.digital/api/v1

LOCAL VPS

http://127.0.0.1:3001/api/v1
Authentication

Todos os endpoints privados utilizam JWT.

Header

Authorization: Bearer <JWT>

Resposta quando inválido

{
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Token inválido."
  }
}
Standard Response
Success
{
  "success": true,
  "data": {},
  "meta": {}
}
Error
{
  "success": false,
  "error": {
    "code": "",
    "message": ""
  }
}
AUTH
POST
/auth/login

Body

{
    "email":"merchant@email.com",
    "password":"123456"
}

Response

{
    "success":true,
    "data":{

        "token":"JWT",

        "merchant":{

            "id":"",

            "name":"",

            "email":""

        }

    }

}
DASHBOARD

GET

/analytics/overview

Headers

Authorization Bearer JWT

Response

{
  "success": true,
  "data": {
    "wallet": {
      "totalBalance": 12540.50,
      "availableBalance": 12000.50,
      "currencies": 2
    },
    "transactions": {
      "today": 15,
      "month": 380,
      "total": 5420,
      "successRate": 98.42,
      "volumeToday": 1250.50,
      "volumeMonth": 34580.40
    },
    "recentTransactions": []
  }
}
WALLETS

GET

/wallets

Response

{
    "success":true,

    "data":{

        "wallets":[

            {

                "currency":"EUR",

                "balance":1250,

                "available":1200,

                "reserved":50,

                "type":"fiat"

            }

        ],

        "summary":{

            "totalBalance":1250,

            "totalAvailable":1200,

            "totalReserved":50,

            "currencies":1

        }

    }

}

GET

/wallets/movements

Response

{
    "success":true,

    "data":[

        {

            "id":"",

            "currency":"EUR",

            "amount":100,

            "direction":"in",

            "status":"available",

            "createdAt":""

        }

    ]

}
TRANSACTIONS

GET

/transactions

Query

?page=1

&limit=20

&status=succeeded

&gateway=stripe

&currency=EUR

&reference=ABC

Response

{
    "success":true,

    "data":[

    ],

    "meta":{

        "page":1,

        "limit":20,

        "total":200,

        "pages":10

    }

}

GET

/transactions/stats

Response

{
    "success":true,

    "data":{

        "total":500,

        "approved":490,

        "failed":5,

        "pending":5,

        "successRate":98,

        "volume":240000

    }

}

GET

/transactions/:id

Response

{
    "success":true,

    "data":{

        "id":"",

        "reference":"",

        "amount":100,

        "currency":"EUR",

        "status":"succeeded",

        "gateway":"stripe",

        "method":"card",

        "createdAt":""

    }

}
CHECKOUT
Criar Sessão

POST

/checkout/session

Headers

Authorization

Bearer API_KEY

Body

{
    "amount":1000,

    "currency":"EUR",

    "reference":"ORDER-001",

    "customerEmail":"customer@mail.com",

    "metadata":{

        "orderId":"123"

    }

}

Response

{
    "success":true,

    "data":{

        "sessionId":"",

        "checkoutUrl":"https://checkout.xpayments.digital/pay/SESSION"

    }

}
Carregar Sessão

GET

/checkout/session/:id

Response

{
    "success":true,

    "data":{

        "sessionId":"",

        "storeName":"",

        "amount":1000,

        "currency":"EUR",

        "reference":"ORDER"

    }

}
PAYMENT API

POST

/payments/charge

Headers

x-api-key

Body

{
    "amount":1000,

    "currency":"EUR",

    "payment_method_types":[

        "card"

    ],

    "metadata":{

        "order_id":"ORDER-1"

    }

}

Response

Stripe PaymentIntent.
