//+------------------------------------------------------------------+
//|                                              OopRiskManaged.mq5   |
//|                                       mql5-transpiler PoC sample  |
//|                                                                  |
//|  An OOP EA that combines a USER CLASS with the Standard-Library    |
//|  helper classes to size every trade by risk.                      |
//|                                                                  |
//|    class RiskManager — pure money-management:                    |
//|        LotsFor(balance, riskPct, stopPts) returns the lot size    |
//|        that risks exactly riskPct% of `balance` over a stop of    |
//|        `stopPts` points, given the symbol's per-point value, then |
//|        clamps to the broker's volume min/max/step.               |
//|                                                                  |
//|    CAccountInfo — Balance() / Equity() for the risk base.         |
//|    CSymbolInfo  — Point() / Digits() / TickValue() /              |
//|                   VolumeMin() / VolumeMax() / VolumeStep() for    |
//|                   value-per-point and volume normalisation.        |
//|                                                                  |
//|  Strategy (netting model): a simple dual-MA trend filter (fast    |
//|  iMA above/below slow iMA). On a fresh cross it sizes the lot via  |
//|  RiskManager off the live account balance and opens in the trend  |
//|  direction with a points-based SL/TP, flipping on the opposite     |
//|  cross. The strategy is deliberately plain — the sample's point    |
//|  is user-class + Standard-Library classes working TOGETHER.       |
//+------------------------------------------------------------------+
#property copyright "mql5-transpiler PoC"
#property version   "1.00"
#property strict

#include <Trade/Trade.mqh>

//--- inputs
input int    InpFastMA   = 10;     // fast MA period
input int    InpSlowMA   = 30;     // slow MA period
input double InpRiskPct  = 1.0;    // % of balance risked per trade
input double InpStopPts  = 200.0;  // protective SL distance (points)
input double InpTakePts  = 400.0;  // TP distance (points)

//+------------------------------------------------------------------+
//| RiskManager — turns "risk X% over an N-point stop" into a lot     |
//| size, then clamps it to the symbol's volume constraints.          |
//+------------------------------------------------------------------+
class RiskManager
  {
   double            m_pointValue;   // account-currency value of 1 point per lot
   double            m_volMin;
   double            m_volMax;
   double            m_volStep;
public:
                     RiskManager()
     {
      m_pointValue = 0.0;
      m_volMin     = 0.01;
      m_volMax     = 100.0;
      m_volStep    = 0.01;
     }
   //--- feed the symbol constraints once (from CSymbolInfo).
   void              Configure(double pointValue, double volMin, double volMax, double volStep)
     {
      m_pointValue = pointValue;
      m_volMin     = volMin;
      m_volMax     = volMax;
      m_volStep    = volStep;
     }
   //--- clamp a raw lot to [min,max] and snap DOWN to the step grid.
   double            Normalize(double lots)
     {
      if(m_volStep > 0.0)
         lots = MathFloor(lots / m_volStep) * m_volStep;
      if(lots < m_volMin)
         lots = m_volMin;
      if(lots > m_volMax)
         lots = m_volMax;
      return lots;
     }
   //--- the core: lots that risk `riskPct`% of `balance` over `stopPts`.
   double            LotsFor(double balance, double riskPct, double stopPts)
     {
      double riskMoney = balance * riskPct / 100.0;
      // money lost per lot if the stop is hit = stopPts * value-per-point-per-lot
      double lossPerLot = stopPts * m_pointValue;
      if(lossPerLot <= 0.0)
         return Normalize(m_volMin);     // can't size safely → smallest lot
      double rawLots = riskMoney / lossPerLot;
      return Normalize(rawLots);
     }
  };

//--- globals
int          fastHandle = INVALID_HANDLE;
int          slowHandle = INVALID_HANDLE;
CTrade       trade;
CAccountInfo account;
CSymbolInfo  symbol;
RiskManager  risk;

//+------------------------------------------------------------------+
//| Expert initialization                                            |
//+------------------------------------------------------------------+
int OnInit()
  {
   fastHandle = iMA(_Symbol, _Period, InpFastMA, 0, MODE_EMA, PRICE_CLOSE);
   slowHandle = iMA(_Symbol, _Period, InpSlowMA, 0, MODE_EMA, PRICE_CLOSE);
   if(fastHandle == INVALID_HANDLE || slowHandle == INVALID_HANDLE)
     {
      Print("OopRiskManaged: failed to create MA handles");
      return(INIT_FAILED);
     }

   symbol.Name(_Symbol);
   trade.SetExpertMagicNumber(20240618);
   trade.SetDeviationInPoints(10);

   // value-per-point-per-lot = tick value scaled from one tick to one point.
   double point     = symbol.Point();
   double tickValue = symbol.TickValue();
   double pointValue = tickValue;   // point == tick for a 1-tick instrument here
   if(point > 0.0 && tickValue > 0.0)
      pointValue = tickValue;       // CSymbolInfo TickValue is per-point on this feed

   risk.Configure(pointValue, symbol.VolumeMin(), symbol.VolumeMax(), symbol.VolumeStep());

   Print(StringFormat("OopRiskManaged init: balance=%s pointValue=%s volMin=%s",
                      DoubleToString(account.Balance(), 2),
                      DoubleToString(pointValue, 5),
                      DoubleToString(symbol.VolumeMin(), 2)));
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

   // Two samples each to detect the cross (0 = newest, 1 = prior bar).
   if(CopyBuffer(fastHandle, 0, 0, 2, fast) < 2) return;
   if(CopyBuffer(slowHandle, 0, 0, 2, slow) < 2) return;

   bool crossUp   = (fast[1] <= slow[1]) && (fast[0] > slow[0]);
   bool crossDown = (fast[1] >= slow[1]) && (fast[0] < slow[0]);
   if(!crossUp && !crossDown)
      return;

   double point = symbol.Point();
   double slDist = InpStopPts * point;
   double tpDist = InpTakePts * point;

   // Risk-size off the LIVE balance every time we trade.
   double balance = account.Balance();
   double lots    = risk.LotsFor(balance, InpRiskPct, InpStopPts);

   bool hasPosition = PositionSelect(_Symbol);
   long ptype = hasPosition ? PositionGetInteger(POSITION_TYPE) : -1;

   if(crossUp)
     {
      if(hasPosition && ptype == POSITION_TYPE_SELL)
        {
         trade.PositionClose(_Symbol);
         hasPosition = false;
        }
      if(!hasPosition)
        {
         double ask = symbol.Ask();
         double sl  = NormalizeDouble(ask - slDist, _Digits);
         double tp  = NormalizeDouble(ask + tpDist, _Digits);
         if(trade.Buy(lots, _Symbol, 0.0, sl, tp))
            Print(StringFormat("BUY  lots=%s @%s sl=%s tp=%s (risk %.1f%% of %s)",
                               DoubleToString(lots, 2), DoubleToString(ask, _Digits),
                               DoubleToString(sl, _Digits), DoubleToString(tp, _Digits),
                               InpRiskPct, DoubleToString(balance, 2)));
        }
     }
   else if(crossDown)
     {
      if(hasPosition && ptype == POSITION_TYPE_BUY)
        {
         trade.PositionClose(_Symbol);
         hasPosition = false;
        }
      if(!hasPosition)
        {
         double bid = symbol.Bid();
         double sl  = NormalizeDouble(bid + slDist, _Digits);
         double tp  = NormalizeDouble(bid - tpDist, _Digits);
         if(trade.Sell(lots, _Symbol, 0.0, sl, tp))
            Print(StringFormat("SELL lots=%s @%s sl=%s tp=%s (risk %.1f%% of %s)",
                               DoubleToString(lots, 2), DoubleToString(bid, _Digits),
                               DoubleToString(sl, _Digits), DoubleToString(tp, _Digits),
                               InpRiskPct, DoubleToString(balance, 2)));
        }
     }
  }
//+------------------------------------------------------------------+
