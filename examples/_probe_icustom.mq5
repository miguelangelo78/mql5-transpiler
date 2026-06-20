//+------------------------------------------------------------------+
//|                                                _probe_icustom.mq5 |
//|                                    mql5-transpiler feature probe   |
//|                                                                  |
//|  Probe for iCustom — calling a SOURCE custom indicator (.mq5).    |
//|  It loads examples/indicators/SimpleMA.mq5 via iCustom, reads its |
//|  output buffer with CopyBuffer (as-series), and trades when the   |
//|  close crosses the custom MA. Exercises the whole iCustom path    |
//|  (compile the indicator, run its OnCalculate, CopyBuffer reads)   |
//|  AND backtests.                                                   |
//+------------------------------------------------------------------+
#property copyright "mql5-transpiler feature probe"
#property version   "1.00"

input int    InpMAPeriod = 14;    // period passed to the custom indicator
input double InpVolume   = 0.10;  // lots per position

int maHandle = INVALID_HANDLE;

//+------------------------------------------------------------------+
int OnInit()
  {
   // iCustom resolves "SimpleMA" → examples/indicators/SimpleMA.mq5, transpiles
   // it, and returns a handle whose buffer 0 is its SMA series. The period is a
   // positional param → the indicator's InpMAPeriod input.
   maHandle = iCustom(_Symbol, _Period, "SimpleMA", InpMAPeriod);
   if(maHandle == INVALID_HANDLE)
     {
      Print("iCustom(SimpleMA) failed to load");
      return(INIT_FAILED);
     }
   Print("iCustom probe initialised, handle=", maHandle, " period=", InpMAPeriod);
   return(INIT_SUCCEEDED);
  }
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   if(maHandle != INVALID_HANDLE)
      IndicatorRelease(maHandle);
  }
//+------------------------------------------------------------------+
void OnTick()
  {
   double ma[];
   ArraySetAsSeries(ma, true);
   // Need the two most-recent MA values to detect a cross.
   if(CopyBuffer(maHandle, 0, 0, 2, ma) < 2)
      return;

   double closeNow  = iClose(_Symbol, _Period, 0);
   double closePrev = iClose(_Symbol, _Period, 1);

   bool crossedUp   = (closePrev <= ma[1] && closeNow > ma[0]);
   bool crossedDown = (closePrev >= ma[1] && closeNow < ma[0]);

   bool hasPos = PositionSelect(_Symbol);

   if(crossedUp && !hasPos)
     {
      MqlTradeRequest request;
      MqlTradeResult  result;
      request.action  = TRADE_ACTION_DEAL;
      request.symbol  = _Symbol;
      request.volume  = InpVolume;
      request.type    = ORDER_TYPE_BUY;
      request.price   = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
      request.comment = "icustom probe";
      OrderSend(request, result);
     }
   else if(crossedDown && hasPos)
     {
      MqlTradeRequest request;
      MqlTradeResult  result;
      request.action   = TRADE_ACTION_DEAL;
      request.symbol   = _Symbol;
      request.volume   = InpVolume;
      request.type     = ORDER_TYPE_SELL;
      request.price    = SymbolInfoDouble(_Symbol, SYMBOL_BID);
      request.position = PositionGetInteger(POSITION_TICKET);
      request.comment  = "icustom probe close";
      OrderSend(request, result);
     }
  }
//+------------------------------------------------------------------+
