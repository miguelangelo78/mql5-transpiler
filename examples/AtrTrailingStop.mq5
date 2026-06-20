//+------------------------------------------------------------------+
//|                                            AtrTrailingStop.mq5    |
//|                                       mql5-transpiler PoC sample  |
//|                                                                  |
//|  A trend-following EA with a VOLATILITY-ADAPTIVE trailing stop.   |
//|                                                                  |
//|  Entry is a simple price-vs-moving-average trigger: go long when  |
//|  price crosses above the MA, short when it crosses below. Once a  |
//|  position is open the EA stops looking for new entries and instead|
//|  RIDES the trend, ratcheting the stop-loss with the Average True  |
//|  Range (ATR):                                                    |
//|                                                                  |
//|    long  -> SL trails to  price - InpAtrMult * ATR               |
//|    short -> SL trails to  price + InpAtrMult * ATR               |
//|                                                                  |
//|  The stop only ever moves in the FAVOURABLE direction (it never  |
//|  loosens), so the ATR distance both lets the trend breathe in     |
//|  volatile conditions and locks in gains as price advances.       |
//|                                                                  |
//|  Exercises: iMA + iATR (MT5 SMA-of-True-Range), CPositionInfo to  |
//|  read the open position (PriceOpen / PositionType / StopLoss /    |
//|  Volume / TakeProfit), and CTrade.PositionModify to move the SL.  |
//+------------------------------------------------------------------+
#property copyright "mql5-transpiler PoC"
#property version   "1.00"
#property strict

#include <Trade/Trade.mqh>

//--- inputs
input int    InpMaPeriod = 20;       // MA period (entry trigger)
input int    InpAtrPeriod = 14;      // ATR period (trail distance)
input double InpAtrMult   = 2.0;     // Trailing-stop distance (ATRs)
input double InpLots      = 0.10;    // Trade volume (lots)

//--- globals
int          maHandle  = INVALID_HANDLE;
int          atrHandle = INVALID_HANDLE;
CTrade       trade;
CPositionInfo position;

//+------------------------------------------------------------------+
//| Expert initialization                                            |
//+------------------------------------------------------------------+
int OnInit()
  {
   maHandle  = iMA(_Symbol, _Period, InpMaPeriod, 0, MODE_SMA, PRICE_CLOSE);
   atrHandle = iATR(_Symbol, _Period, InpAtrPeriod);

   if(maHandle == INVALID_HANDLE || atrHandle == INVALID_HANDLE)
     {
      Print("AtrTrailingStop: failed to create indicator handles");
      return(INIT_FAILED);
     }

   trade.SetExpertMagicNumber(20240502);
   Print(StringFormat("AtrTrailingStop init: ma(%d) atr(%d) x%.1f",
                      InpMaPeriod, InpAtrPeriod, InpAtrMult));
   return(INIT_SUCCEEDED);
  }
//+------------------------------------------------------------------+
//| Expert deinitialization                                          |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   IndicatorRelease(maHandle);
   IndicatorRelease(atrHandle);
  }
//+------------------------------------------------------------------+
//| Trail the stop of the open position by `atr` ATRs.               |
//| Moves the SL only in the favourable direction (never loosens).   |
//+------------------------------------------------------------------+
void TrailStop(double atr)
  {
   if(!position.Select(_Symbol))
      return;

   double bid    = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double curSl  = position.StopLoss();    // 0 = no stop yet (§29: a real value)
   double tp     = position.TakeProfit();
   long   ptype  = position.PositionType();
   double offset = InpAtrMult * atr;

   if(ptype == POSITION_TYPE_BUY)
     {
      double newSl = NormalizeDouble(bid - offset, _Digits);
      // Ratchet up only: tighten the stop when price has advanced, never widen.
      if(newSl > curSl || curSl == 0.0)
        {
         if(trade.PositionModify(_Symbol, newSl, tp))
            Print(StringFormat("TRAIL long  SL %s -> %s",
                               DoubleToString(curSl, _Digits),
                               DoubleToString(newSl, _Digits)));
        }
     }
   else if(ptype == POSITION_TYPE_SELL)
     {
      double newSl = NormalizeDouble(bid + offset, _Digits);
      // Ratchet down only for a short (tighten as price falls).
      if(newSl < curSl || curSl == 0.0)
        {
         if(trade.PositionModify(_Symbol, newSl, tp))
            Print(StringFormat("TRAIL short SL %s -> %s",
                               DoubleToString(curSl, _Digits),
                               DoubleToString(newSl, _Digits)));
        }
     }
  }
//+------------------------------------------------------------------+
//| Expert tick                                                      |
//+------------------------------------------------------------------+
void OnTick()
  {
   double ma[];
   double atr[];
   ArraySetAsSeries(ma, true);
   ArraySetAsSeries(atr, true);

   // Three MA samples so the last two CLOSED bars (index 1 and 2) each have a
   // matching MA value to test the cross; one ATR for the trail distance.
   if(CopyBuffer(maHandle,  0, 0, 3, ma)  < 3) return;
   if(CopyBuffer(atrHandle, 0, 0, 1, atr) < 1) return;

   double a = atr[0];

   //--- Manage the open position: trail its stop, then we're done. -------
   if(PositionSelect(_Symbol))
     {
      TrailStop(a);
      return;
     }

   //--- Flat: look for a fresh price/MA cross to enter. ------------------
   double closePrev = iClose(_Symbol, _Period, 1);   // last closed bar
   double closeOld  = iClose(_Symbol, _Period, 2);   // the bar before it
   double maPrev    = ma[1];   // MA aligned with the last closed bar
   double maOld     = ma[2];   // MA aligned with the bar before it
   // Cross of the just-closed price through the MA (price was on one side of
   // the MA on the older bar and ends on the other side on the newer bar).
   bool crossUp   = (closeOld <= maOld) && (closePrev > maPrev);
   bool crossDown = (closeOld >= maOld) && (closePrev < maPrev);

   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);

   if(crossUp)
     {
      double sl = NormalizeDouble(bid - InpAtrMult * a, _Digits);
      if(trade.Buy(InpLots, _Symbol, 0.0, sl, 0.0))
         Print(StringFormat("BUY  @%s sl=%s (price crossed above MA)",
                            DoubleToString(bid, _Digits),
                            DoubleToString(sl, _Digits)));
     }
   else if(crossDown)
     {
      double sl = NormalizeDouble(bid + InpAtrMult * a, _Digits);
      if(trade.Sell(InpLots, _Symbol, 0.0, sl, 0.0))
         Print(StringFormat("SELL @%s sl=%s (price crossed below MA)",
                            DoubleToString(bid, _Digits),
                            DoubleToString(sl, _Digits)));
     }
  }
//+------------------------------------------------------------------+
