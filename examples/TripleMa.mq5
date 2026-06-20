//+------------------------------------------------------------------+
//|                                                  TripleMa.mq5     |
//|                                       mql5-transpiler PoC sample  |
//|                                                                  |
//|  A THREE-MA "stack" trend EA.                                    |
//|   - Computes a FAST, a MEDIUM and a SLOW simple moving average.  |
//|   - Goes LONG  when the MAs are stacked UP   (fast > med > slow):|
//|     every shorter average sits above the longer one — a clean    |
//|     up-trend.                                                    |
//|   - Goes SHORT when the MAs are stacked DOWN (fast < med < slow).|
//|   - Goes FLAT  (closes any open position) when the stack is      |
//|     tangled — i.e. neither cleanly up nor cleanly down — so the  |
//|     EA only holds while the trend alignment is unambiguous.      |
//|                                                                  |
//|  Exercises: three iMA(SMA) handles read via CopyBuffer, CTrade   |
//|  Buy/Sell/PositionClose, the netting position model.            |
//+------------------------------------------------------------------+
#property copyright "mql5-transpiler PoC"
#property version   "1.00"
#property strict

#include <Trade/Trade.mqh>

//--- inputs
input int    InpFastPeriod = 5;      // Fast SMA period
input int    InpMedPeriod  = 20;     // Medium SMA period
input int    InpSlowPeriod = 50;     // Slow SMA period
input double InpLots       = 0.10;   // Trade volume (lots)

//--- globals
int    fastHandle = INVALID_HANDLE;
int    medHandle  = INVALID_HANDLE;
int    slowHandle = INVALID_HANDLE;
CTrade trade;

//+------------------------------------------------------------------+
//| Expert initialization                                            |
//+------------------------------------------------------------------+
int OnInit()
  {
   fastHandle = iMA(_Symbol, _Period, InpFastPeriod, 0, MODE_SMA, PRICE_CLOSE);
   medHandle  = iMA(_Symbol, _Period, InpMedPeriod,  0, MODE_SMA, PRICE_CLOSE);
   slowHandle = iMA(_Symbol, _Period, InpSlowPeriod, 0, MODE_SMA, PRICE_CLOSE);

   if(fastHandle == INVALID_HANDLE || medHandle == INVALID_HANDLE || slowHandle == INVALID_HANDLE)
     {
      Print("TripleMa: failed to create one or more MA handles");
      return(INIT_FAILED);
     }

   Print("TripleMa initialised: fast=", InpFastPeriod, " med=", InpMedPeriod, " slow=", InpSlowPeriod);
   return(INIT_SUCCEEDED);
  }
//+------------------------------------------------------------------+
//| Expert deinitialization                                          |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   IndicatorRelease(fastHandle);
   IndicatorRelease(medHandle);
   IndicatorRelease(slowHandle);
  }
//+------------------------------------------------------------------+
//| Expert tick                                                      |
//+------------------------------------------------------------------+
void OnTick()
  {
   double fast[];
   double med[];
   double slow[];
   ArraySetAsSeries(fast, true);
   ArraySetAsSeries(med, true);
   ArraySetAsSeries(slow, true);

   // One sample of each MA (index 0 = current bar) is all the stack test needs.
   if(CopyBuffer(fastHandle, 0, 0, 1, fast) < 1)
      return;
   if(CopyBuffer(medHandle,  0, 0, 1, med)  < 1)
      return;
   if(CopyBuffer(slowHandle, 0, 0, 1, slow) < 1)
      return;

   bool stackedUp   = (fast[0] > med[0]) && (med[0] > slow[0]);
   bool stackedDown = (fast[0] < med[0]) && (med[0] < slow[0]);

   bool hasPosition = PositionSelect(_Symbol);
   long ptype = hasPosition ? PositionGetInteger(POSITION_TYPE) : -1;

   if(stackedUp)
     {
      // Clean up-trend — flip any short, then go long if flat.
      if(hasPosition && ptype == POSITION_TYPE_SELL)
        {
         trade.PositionClose(_Symbol);
         hasPosition = false;
        }
      if(!hasPosition)
         trade.Buy(InpLots, _Symbol);
     }
   else if(stackedDown)
     {
      // Clean down-trend — flip any long, then go short if flat.
      if(hasPosition && ptype == POSITION_TYPE_BUY)
        {
         trade.PositionClose(_Symbol);
         hasPosition = false;
        }
      if(!hasPosition)
         trade.Sell(InpLots, _Symbol);
     }
   else
     {
      // Stack is tangled — no clean trend. Stand aside (close any position).
      if(hasPosition)
         trade.PositionClose(_Symbol);
     }
  }
//+------------------------------------------------------------------+
