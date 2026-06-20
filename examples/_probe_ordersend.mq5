//+------------------------------------------------------------------+
//|                                              _probe_ordersend.mq5 |
//|                                    mql5-transpiler feature probe   |
//|                                                                  |
//|  Probe for the RAW TRADE API: MqlTradeRequest / MqlTradeResult    |
//|  structs + OrderSend. On each tick, if there is no open position, |
//|  it builds a market-buy request and sends it via OrderSend (the   |
//|  low-level MT5 primitive that CTrade is built on). Exercises the  |
//|  struct zero-init, field assignment, and the awaited broker I/O   |
//|  call — so it both transpiles cleanly AND actually trades in the  |
//|  backtest.                                                        |
//+------------------------------------------------------------------+
#property copyright "mql5-transpiler feature probe"
#property version   "1.00"

input double InpVolume = 0.10;   // lots per market order

//+------------------------------------------------------------------+
int OnInit()
  {
   Print("OrderSend probe initialised, volume=", InpVolume);
   return(INIT_SUCCEEDED);
  }
//+------------------------------------------------------------------+
void OnTick()
  {
   // Trade at most once: only open when flat on the bound symbol.
   if(PositionSelect(_Symbol))
      return;

   MqlTradeRequest request;
   MqlTradeResult  result;

   request.action   = TRADE_ACTION_DEAL;     // immediate market execution
   request.symbol   = _Symbol;
   request.volume   = InpVolume;
   request.type     = ORDER_TYPE_BUY;
   request.price    = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   request.deviation = 10;
   request.comment  = "ordersend probe";

   if(OrderSend(request, result))
      Print("OrderSend ok, retcode=", result.retcode, " deal=", result.deal);
   else
      Print("OrderSend failed, retcode=", result.retcode, " ", result.comment);
  }
//+------------------------------------------------------------------+
