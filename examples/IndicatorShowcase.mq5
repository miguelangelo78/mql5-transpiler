//+------------------------------------------------------------------+
//|                                          IndicatorShowcase.mq5    |
//|                                       mql5-transpiler PoC sample  |
//|                                                                  |
//|  A MACD-crossover TREND EA — confirmed by Stochastic and risk-    |
//|  sized off the Bollinger channel — that exercises a broad spread  |
//|  of the newly-implemented runtime builtins:                       |
//|                                                                  |
//|    - iBands  (BASE/UPPER/LOWER via CopyBuffer buffers 0/1/2)      |
//|    - iMACD   (MAIN/SIGNAL via CopyBuffer buffers 0/1)             |
//|    - iStochastic (%K via CopyBuffer buffer 0)                    |
//|    - Math* (MathAbs / MathMax / MathMin) for risk sizing          |
//|    - String* (StringFormat) + DoubleToString for logging          |
//|    - OrdersTotal()  (pending-pool guard)                         |
//|                                                                  |
//|  Strategy (netting model):                                       |
//|    BUY  when the MACD main line crosses ABOVE its signal line     |
//|         (momentum turning up), as long as Stochastic %K is not    |
//|         already overbought.                                       |
//|    SELL the mirror image (MACD crosses below, %K not oversold).   |
//|    Flips the position on the opposite cross (rides the trend).    |
//|    A protective SL/TP is sized off the Bollinger half-width,      |
//|    floored to a minimum distance and rounded to the symbol's      |
//|    digits.                                                       |
//+------------------------------------------------------------------+
#property copyright "mql5-transpiler PoC"
#property version   "1.00"
#property strict

#include <Trade/Trade.mqh>

//--- inputs
input int    InpBandsPeriod = 20;     // Bollinger period
input double InpBandsDev     = 2.0;   // Bollinger deviation (sigmas)
input int    InpMacdFast     = 12;    // MACD fast EMA
input int    InpMacdSlow     = 26;    // MACD slow EMA
input int    InpMacdSignal   = 9;     // MACD signal SMA
input int    InpStochK       = 5;     // Stochastic %K period
input int    InpStochD       = 3;     // Stochastic %D period
input int    InpStochSlow    = 3;     // Stochastic slowing
input double InpStochOS       = 30.0; // Stochastic oversold level
input double InpStochOB       = 70.0; // Stochastic overbought level
input double InpLots          = 0.10; // Trade volume (lots)
input double InpMinStopPoints = 50.0; // Minimum SL/TP distance (points)

//--- globals
int    bandsHandle = INVALID_HANDLE;
int    macdHandle  = INVALID_HANDLE;
int    stochHandle = INVALID_HANDLE;
CTrade trade;

//+------------------------------------------------------------------+
//| Expert initialization                                            |
//+------------------------------------------------------------------+
int OnInit()
  {
   bandsHandle = iBands(_Symbol, _Period, InpBandsPeriod, 0, InpBandsDev, PRICE_CLOSE);
   macdHandle  = iMACD(_Symbol, _Period, InpMacdFast, InpMacdSlow, InpMacdSignal, PRICE_CLOSE);
   stochHandle = iStochastic(_Symbol, _Period, InpStochK, InpStochD, InpStochSlow, MODE_SMA, 0);

   if(bandsHandle == INVALID_HANDLE || macdHandle == INVALID_HANDLE || stochHandle == INVALID_HANDLE)
     {
      Print("IndicatorShowcase: failed to create indicator handles");
      return(INIT_FAILED);
     }

   string banner = StringFormat("IndicatorShowcase init: bands(%d,%.1f) macd(%d,%d,%d) stoch(%d,%d,%d)",
                                InpBandsPeriod, InpBandsDev,
                                InpMacdFast, InpMacdSlow, InpMacdSignal,
                                InpStochK, InpStochD, InpStochSlow);
   Print(banner);
   return(INIT_SUCCEEDED);
  }
//+------------------------------------------------------------------+
//| Expert deinitialization                                          |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   IndicatorRelease(bandsHandle);
   IndicatorRelease(macdHandle);
   IndicatorRelease(stochHandle);
  }
//+------------------------------------------------------------------+
//| Compute a protective stop distance from the band half-width,     |
//| floored to a minimum and rounded to the symbol's price step.     |
//+------------------------------------------------------------------+
double StopDistance(double upper, double lower)
  {
   double halfWidth = MathAbs(upper - lower) * 0.5;
   double floorDist = InpMinStopPoints * _Point;
   double dist      = MathMax(halfWidth, floorDist);
   return(NormalizeDouble(dist, _Digits));
  }
//+------------------------------------------------------------------+
//| Expert tick                                                      |
//+------------------------------------------------------------------+
void OnTick()
  {
   double base[];
   double upper[];
   double lower[];
   double macdMain[];
   double macdSig[];
   double stochK[];

   ArraySetAsSeries(base, true);
   ArraySetAsSeries(upper, true);
   ArraySetAsSeries(lower, true);
   ArraySetAsSeries(macdMain, true);
   ArraySetAsSeries(macdSig, true);
   ArraySetAsSeries(stochK, true);

   // Two MACD samples (index 0 = newest, 1 = prior bar) to detect a cross; one
   // Stochastic %K + one of each band is enough. Bail until every series warms.
   if(CopyBuffer(bandsHandle, 0, 0, 1, base)  < 1) return;
   if(CopyBuffer(bandsHandle, 1, 0, 1, upper) < 1) return;
   if(CopyBuffer(bandsHandle, 2, 0, 1, lower) < 1) return;
   if(CopyBuffer(macdHandle,  0, 0, 2, macdMain) < 2) return;
   if(CopyBuffer(macdHandle,  1, 0, 2, macdSig)  < 2) return;
   if(CopyBuffer(stochHandle, 0, 0, 1, stochK)   < 1) return;

   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);

   // MACD main crossing its signal line — the trend trigger.
   bool crossUp   = (macdMain[1] <= macdSig[1]) && (macdMain[0] > macdSig[0]);
   bool crossDown = (macdMain[1] >= macdSig[1]) && (macdMain[0] < macdSig[0]);

   // Stochastic veto: don't buy into an already-overbought reading, and don't
   // sell into an already-oversold one (avoids entering at an exhausted move).
   bool notOverbought = stochK[0] < InpStochOB;
   bool notOversold   = stochK[0] > InpStochOS;

   bool longSignal  = crossUp   && notOverbought;
   bool shortSignal = crossDown && notOversold;

   bool hasPosition = PositionSelect(_Symbol);
   long ptype = hasPosition ? PositionGetInteger(POSITION_TYPE) : -1;

   // SL/TP sized off the Bollinger half-width (a volatility proxy), floored.
   double dist = StopDistance(upper[0], lower[0]);

   if(longSignal)
     {
      // Flip a short, then open a long if flat and nothing is pending.
      if(hasPosition && ptype == POSITION_TYPE_SELL)
        {
         trade.PositionClose(_Symbol);
         hasPosition = false;
        }
      if(!hasPosition && OrdersTotal() == 0)
        {
         double sl = NormalizeDouble(bid - dist, _Digits);
         double tp = NormalizeDouble(bid + dist, _Digits);
         if(trade.Buy(InpLots, _Symbol, 0.0, sl, tp))
            Print(StringFormat("BUY  @%s sl=%s tp=%s k=%s", DoubleToString(bid, _Digits),
                               DoubleToString(sl, _Digits), DoubleToString(tp, _Digits),
                               DoubleToString(stochK[0], 1)));
        }
     }
   else if(shortSignal)
     {
      if(hasPosition && ptype == POSITION_TYPE_BUY)
        {
         trade.PositionClose(_Symbol);
         hasPosition = false;
        }
      if(!hasPosition && OrdersTotal() == 0)
        {
         double sl = NormalizeDouble(bid + dist, _Digits);
         double tp = NormalizeDouble(bid - dist, _Digits);
         if(trade.Sell(InpLots, _Symbol, 0.0, sl, tp))
            Print(StringFormat("SELL @%s sl=%s tp=%s k=%s", DoubleToString(bid, _Digits),
                               DoubleToString(sl, _Digits), DoubleToString(tp, _Digits),
                               DoubleToString(stochK[0], 1)));
        }
     }
  }
//+------------------------------------------------------------------+
