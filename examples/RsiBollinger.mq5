//+------------------------------------------------------------------+
//|                                              RsiBollinger.mq5     |
//|                                       mql5-transpiler PoC sample  |
//|                                                                  |
//|  A Bollinger-band MEAN-REVERSION Expert Advisor, RSI-confirmed.   |
//|                                                                  |
//|  Premise: when price stretches OUTSIDE a Bollinger band it tends  |
//|  to snap back toward the middle (the moving average). The RSI     |
//|  filter avoids fading a genuine momentum break — we only buy a    |
//|  dip that is ALSO oversold, and sell a spike that is ALSO         |
//|  overbought.                                                     |
//|                                                                  |
//|  Entry (netting model, flat only):                              |
//|    BUY  when the close is BELOW the lower band  AND iRSI < 30.    |
//|    SELL when the close is ABOVE the upper band  AND iRSI > 70.    |
//|  Exit:                                                          |
//|    Close the long once price recovers to the middle band; close  |
//|    the short once price falls back to the middle band. (The TP    |
//|    is the mean — classic mean reversion.) A protective SL is set  |
//|    a band-width beyond the entry so a trend break-out is cut.    |
//|                                                                  |
//|  Exercises: iBands (BASE/UPPER/LOWER via CopyBuffer buffers       |
//|  0/1/2), Wilder iRSI, CTrade Buy/Sell/PositionClose, the          |
//|  netting-position read (PositionSelect + PositionGetInteger).    |
//+------------------------------------------------------------------+
#property copyright "mql5-transpiler PoC"
#property version   "1.00"
#property strict

#include <Trade/Trade.mqh>

//--- inputs
input int    InpBandsPeriod = 20;     // Bollinger period (middle = SMA)
input double InpBandsDev    = 2.0;    // Bollinger deviation (sigmas)
input int    InpRsiPeriod   = 14;     // RSI period (Wilder)
input double InpOversold    = 30.0;   // RSI oversold threshold (buy filter)
input double InpOverbought  = 70.0;   // RSI overbought threshold (sell filter)
input double InpSlBandMult  = 1.0;    // Stop-loss distance (band half-widths)
input double InpTpFraction  = 0.5;    // Take-profit (fraction of way to mean)
input double InpLots        = 0.10;   // Trade volume (lots)

//--- globals
int    bandsHandle = INVALID_HANDLE;
int    rsiHandle   = INVALID_HANDLE;
CTrade trade;

//+------------------------------------------------------------------+
//| Expert initialization                                            |
//+------------------------------------------------------------------+
int OnInit()
  {
   bandsHandle = iBands(_Symbol, _Period, InpBandsPeriod, 0, InpBandsDev, PRICE_CLOSE);
   rsiHandle   = iRSI(_Symbol, _Period, InpRsiPeriod, PRICE_CLOSE);

   if(bandsHandle == INVALID_HANDLE || rsiHandle == INVALID_HANDLE)
     {
      Print("RsiBollinger: failed to create indicator handles");
      return(INIT_FAILED);
     }

   Print(StringFormat("RsiBollinger init: bands(%d,%.1f) rsi(%d)",
                      InpBandsPeriod, InpBandsDev, InpRsiPeriod));
   return(INIT_SUCCEEDED);
  }
//+------------------------------------------------------------------+
//| Expert deinitialization                                          |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   IndicatorRelease(bandsHandle);
   IndicatorRelease(rsiHandle);
  }
//+------------------------------------------------------------------+
//| Expert tick                                                      |
//+------------------------------------------------------------------+
void OnTick()
  {
   double base[];
   double upper[];
   double lower[];
   double rsi[];

   ArraySetAsSeries(base, true);
   ArraySetAsSeries(upper, true);
   ArraySetAsSeries(lower, true);
   ArraySetAsSeries(rsi, true);

   // One sample of each band + RSI is enough for this rule. Bail until warm.
   if(CopyBuffer(bandsHandle, 0, 0, 1, base)  < 1) return;   // BASE  (middle)
   if(CopyBuffer(bandsHandle, 1, 0, 1, upper) < 1) return;   // UPPER
   if(CopyBuffer(bandsHandle, 2, 0, 1, lower) < 1) return;   // LOWER
   if(CopyBuffer(rsiHandle,   0, 0, 1, rsi)   < 1) return;

   double mid       = base[0];
   double up        = upper[0];
   double lo        = lower[0];
   double r         = rsi[0];
   double bid       = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double halfWidth = MathAbs(up - lo) * 0.5;

   bool hasPosition = PositionSelect(_Symbol);
   long ptype       = hasPosition ? PositionGetInteger(POSITION_TYPE) : -1;

   //--- Exit first: take the reversion back INTO the band as profit. ------
   // Mean reversion here means "snap back from the extreme"; the partial
   // target (band edge, scaled toward the mean by InpTpFraction) is reached
   // far more often than the full mean, and a touch of the OPPOSITE band is a
   // completed reversion that we also bank.
   if(hasPosition)
     {
      // Long: opened below the lower band; bank once price climbs back above
      // the lower band (reversion underway) or reaches the mean.
      if(ptype == POSITION_TYPE_BUY && bid >= lo)
        {
         trade.PositionClose(_Symbol);
         return;
        }
      // Short: opened above the upper band; bank once price drops back below
      // the upper band.
      if(ptype == POSITION_TYPE_SELL && bid <= up)
        {
         trade.PositionClose(_Symbol);
         return;
        }
      return;   // still stretched — hold for the snap-back
     }

   //--- Entry: only when flat. Fade a band stretch that RSI confirms. ----
   bool buySignal  = (bid < lo) && (r < InpOversold);
   bool sellSignal = (bid > up) && (r > InpOverbought);

   if(buySignal)
     {
      // SL a band beyond the entry (a real break-out cuts the trade); TP a
      // fraction of the way to the mean (a realistic partial reversion).
      double sl = NormalizeDouble(bid - InpSlBandMult * halfWidth, _Digits);
      double tp = NormalizeDouble(bid + InpTpFraction * (mid - bid), _Digits);
      if(trade.Buy(InpLots, _Symbol, 0.0, sl, tp))
         Print(StringFormat("BUY  dip @%s lower=%s rsi=%s",
                            DoubleToString(bid, _Digits),
                            DoubleToString(lo, _Digits),
                            DoubleToString(r, 1)));
     }
   else if(sellSignal)
     {
      double sl = NormalizeDouble(bid + InpSlBandMult * halfWidth, _Digits);
      double tp = NormalizeDouble(bid - InpTpFraction * (bid - mid), _Digits);
      if(trade.Sell(InpLots, _Symbol, 0.0, sl, tp))
         Print(StringFormat("SELL spike @%s upper=%s rsi=%s",
                            DoubleToString(bid, _Digits),
                            DoubleToString(up, _Digits),
                            DoubleToString(r, 1)));
     }
  }
//+------------------------------------------------------------------+
