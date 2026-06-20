//+------------------------------------------------------------------+
//|                                            AdxTrendFilter.mq5     |
//|                                       mql5-transpiler PoC sample  |
//|                                                                  |
//|  An MA-crossover EA gated by an ADX TREND-STRENGTH FILTER.       |
//|                                                                  |
//|  A plain MA cross whipsaws in a range. ADX measures how strong   |
//|  the prevailing trend is (regardless of direction): a reading    |
//|  above the threshold means "there IS a trend worth riding".      |
//|   - Only take a crossover when iADX(14) MAIN > InpAdxThreshold.   |
//|   - LONG  on a fast-above-slow cross while ADX confirms strength. |
//|   - SHORT on a fast-below-slow cross while ADX confirms strength. |
//|   - Flip on the opposite (confirmed) cross; otherwise hold.       |
//|                                                                  |
//|  Exercises iADX's multi-buffer CopyBuffer (0=MAIN ADX, 1=+DI,    |
//|  2=-DI): the +DI/-DI buffers are read to log the directional     |
//|  bias alongside the trend-strength gate.                        |
//+------------------------------------------------------------------+
#property copyright "mql5-transpiler PoC"
#property version   "1.00"
#property strict

#include <Trade/Trade.mqh>

//--- inputs
input int    InpFastPeriod  = 10;     // Fast SMA period
input int    InpSlowPeriod  = 30;     // Slow SMA period
input int    InpAdxPeriod   = 14;     // ADX period
input double InpAdxThreshold = 25.0;  // Min ADX MAIN to allow a trade
input double InpLots        = 0.10;   // Trade volume (lots)

//--- globals
int    fastHandle = INVALID_HANDLE;
int    slowHandle = INVALID_HANDLE;
int    adxHandle  = INVALID_HANDLE;
CTrade trade;

//+------------------------------------------------------------------+
//| Expert initialization                                            |
//+------------------------------------------------------------------+
int OnInit()
  {
   fastHandle = iMA(_Symbol, _Period, InpFastPeriod, 0, MODE_SMA, PRICE_CLOSE);
   slowHandle = iMA(_Symbol, _Period, InpSlowPeriod, 0, MODE_SMA, PRICE_CLOSE);
   adxHandle  = iADX(_Symbol, _Period, InpAdxPeriod);

   if(fastHandle == INVALID_HANDLE || slowHandle == INVALID_HANDLE || adxHandle == INVALID_HANDLE)
     {
      Print("AdxTrendFilter: failed to create indicator handles");
      return(INIT_FAILED);
     }

   Print("AdxTrendFilter initialised: fast=", InpFastPeriod, " slow=", InpSlowPeriod,
         " adx=", InpAdxPeriod, " threshold=", DoubleToString(InpAdxThreshold, 1));
   return(INIT_SUCCEEDED);
  }
//+------------------------------------------------------------------+
//| Expert deinitialization                                          |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   IndicatorRelease(fastHandle);
   IndicatorRelease(slowHandle);
   IndicatorRelease(adxHandle);
  }
//+------------------------------------------------------------------+
//| Expert tick                                                      |
//+------------------------------------------------------------------+
void OnTick()
  {
   double fast[];
   double slow[];
   double adxMain[];
   double plusDi[];
   double minusDi[];
   ArraySetAsSeries(fast, true);
   ArraySetAsSeries(slow, true);
   ArraySetAsSeries(adxMain, true);
   ArraySetAsSeries(plusDi, true);
   ArraySetAsSeries(minusDi, true);

   // Two MA samples (0 = newest, 1 = prior) to detect a cross; one ADX sample.
   if(CopyBuffer(fastHandle, 0, 0, 2, fast) < 2)
      return;
   if(CopyBuffer(slowHandle, 0, 0, 2, slow) < 2)
      return;
   if(CopyBuffer(adxHandle, 0, 0, 1, adxMain) < 1)   // buffer 0 = MAIN (ADX)
      return;
   if(CopyBuffer(adxHandle, 1, 0, 1, plusDi) < 1)    // buffer 1 = +DI
      return;
   if(CopyBuffer(adxHandle, 2, 0, 1, minusDi) < 1)   // buffer 2 = -DI
      return;

   bool crossUp   = (fast[1] <= slow[1]) && (fast[0] > slow[0]);
   bool crossDown = (fast[1] >= slow[1]) && (fast[0] < slow[0]);

   // The trend-strength gate: only act when ADX confirms a real trend.
   bool trending = adxMain[0] > InpAdxThreshold;

   bool hasPosition = PositionSelect(_Symbol);
   long ptype = hasPosition ? PositionGetInteger(POSITION_TYPE) : -1;

   if(crossUp && trending)
     {
      if(hasPosition && ptype == POSITION_TYPE_SELL)
        {
         trade.PositionClose(_Symbol);
         hasPosition = false;
        }
      if(!hasPosition)
        {
         if(trade.Buy(InpLots, _Symbol))
            Print(StringFormat("BUY  adx=%s +DI=%s -DI=%s",
                               DoubleToString(adxMain[0], 1),
                               DoubleToString(plusDi[0], 1),
                               DoubleToString(minusDi[0], 1)));
        }
     }
   else if(crossDown && trending)
     {
      if(hasPosition && ptype == POSITION_TYPE_BUY)
        {
         trade.PositionClose(_Symbol);
         hasPosition = false;
        }
      if(!hasPosition)
        {
         if(trade.Sell(InpLots, _Symbol))
            Print(StringFormat("SELL adx=%s +DI=%s -DI=%s",
                               DoubleToString(adxMain[0], 1),
                               DoubleToString(plusDi[0], 1),
                               DoubleToString(minusDi[0], 1)));
        }
     }
  }
//+------------------------------------------------------------------+
