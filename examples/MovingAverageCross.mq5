//+------------------------------------------------------------------+
//|                                         MovingAverageCross.mq5    |
//|                                       mql5-transpiler PoC sample  |
//|                                                                  |
//|  A classic SMA-crossover Expert Advisor.                         |
//|  - Goes long  when the fast SMA crosses above the slow SMA.      |
//|  - Goes short when the fast SMA crosses below the slow SMA.      |
//|  - Flips the position on the opposite signal (netting model).    |
//+------------------------------------------------------------------+
#property copyright "mql5-transpiler PoC"
#property version   "1.00"
#property strict

#include <Trade/Trade.mqh>

//--- inputs
input int    InpFastPeriod = 10;     // Fast SMA period
input int    InpSlowPeriod = 30;     // Slow SMA period
input double InpLots       = 0.10;   // Trade volume (lots)

//--- globals
int    fastHandle = INVALID_HANDLE;
int    slowHandle = INVALID_HANDLE;
CTrade trade;

//+------------------------------------------------------------------+
//| Expert initialization                                            |
//+------------------------------------------------------------------+
int OnInit()
  {
   fastHandle = iMA(_Symbol, _Period, InpFastPeriod, 0, MODE_SMA, PRICE_CLOSE);
   slowHandle = iMA(_Symbol, _Period, InpSlowPeriod, 0, MODE_SMA, PRICE_CLOSE);

   if(fastHandle == INVALID_HANDLE || slowHandle == INVALID_HANDLE)
     {
      Print("Failed to create indicator handles");
      return(INIT_FAILED);
     }

   Print("MovingAverageCross initialised: fast=", InpFastPeriod, " slow=", InpSlowPeriod);
   return(INIT_SUCCEEDED);
  }
//+------------------------------------------------------------------+
//| Expert deinitialization                                          |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   IndicatorRelease(fastHandle);
   IndicatorRelease(slowHandle);
  }
//+------------------------------------------------------------------+
//| Expert tick                                                      |
//+------------------------------------------------------------------+
void OnTick()
  {
   double fast[];
   double slow[];
   ArraySetAsSeries(fast, true);
   ArraySetAsSeries(slow, true);

   if(CopyBuffer(fastHandle, 0, 0, 3, fast) < 3)
      return;
   if(CopyBuffer(slowHandle, 0, 0, 3, slow) < 3)
      return;

   bool crossedUp   = (fast[1] <= slow[1]) && (fast[0] > slow[0]);
   bool crossedDown = (fast[1] >= slow[1]) && (fast[0] < slow[0]);

   if(crossedUp)
     {
      if(PositionSelect(_Symbol) && PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_SELL)
         trade.PositionClose(_Symbol);
      if(!PositionSelect(_Symbol))
         trade.Buy(InpLots, _Symbol);
     }
   else if(crossedDown)
     {
      if(PositionSelect(_Symbol) && PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY)
         trade.PositionClose(_Symbol);
      if(!PositionSelect(_Symbol))
         trade.Sell(InpLots, _Symbol);
     }
  }
//+------------------------------------------------------------------+
